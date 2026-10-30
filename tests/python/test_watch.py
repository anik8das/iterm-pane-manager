import argparse
import asyncio
import json
import os
import pathlib
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest import mock

import iterm2
import watch


def options(**overrides):
    values = dict(
        interval=5.0, debounce=250.0, tolerance=12.0, once=False, verbose=False
    )
    values.update(overrides)
    return argparse.Namespace(**values)


class SweepSurvivesRoundFailures(unittest.IsolatedAsyncioTestCase):
    """A tab changing under one sweep must not end the watcher.

    Opening a document is itself what changes the pane tree, so the round that
    fails is the round that most needs to run. Ending the process there hands
    the tab to launchd's restart delay at exactly the wrong moment.
    """

    def setUp(self):
        self.watcher = watch.Watcher(app=object(), options=options())

    async def test_a_tree_that_changed_mid_sweep_is_retried_not_fatal(self):
        raised = iterm2.rpc.RPCException("WRONG_TREE")
        with (
            mock.patch.object(watch.Watcher, "sweep", side_effect=raised),
            mock.patch.object(watch, "log") as logged,
        ):
            self.assertIs(await self.watcher.sweep_guarded("event"), False)
        self.assertIn("WRONG_TREE", logged.call_args[0][0])

    async def test_a_busy_iterm_times_out_without_ending_the_watcher(self):
        with (
            mock.patch.object(
                watch.Watcher, "sweep", side_effect=asyncio.TimeoutError()
            ),
            mock.patch.object(watch, "log"),
        ):
            self.assertIs(await self.watcher.sweep_guarded("poll"), False)

    async def test_an_unresponsive_refresh_ends_the_connection_lifecycle(self):
        self.watcher.app = SimpleNamespace(
            async_refresh=mock.AsyncMock(side_effect=asyncio.TimeoutError())
        )
        with self.assertRaisesRegex(
            ConnectionError, "refresh before sizing.*no longer responsive"
        ):
            await self.watcher.sweep_guarded("poll")

    async def test_a_clean_sweep_still_reports_success(self):
        with mock.patch.object(watch.Watcher, "sweep", return_value=None):
            self.assertIs(await self.watcher.sweep_guarded("focus"), True)

    async def test_an_unreadable_command_lock_is_reported_without_restarting(self):
        with (
            mock.patch.object(
                watch.Watcher,
                "sweep",
                side_effect=watch.LayoutLockError("cannot inspect command lock"),
            ),
            mock.patch.object(watch, "log") as logged,
        ):
            self.assertIs(await self.watcher.sweep_guarded("event"), False)
        self.assertIn("cannot inspect command lock", logged.call_args.args[0])

    async def test_request_timeout_retains_its_stage_and_async_exception_type(self):
        with (
            mock.patch.object(watch, "RPC_TIMEOUT", 0),
            self.assertRaisesRegex(asyncio.TimeoutError, "verification exceeded"),
        ):
            await watch.request(asyncio.sleep(1), "verification")

    async def test_a_lost_connection_still_ends_the_process(self):
        """launchd restarting is the right answer to a dead connection."""
        with (
            mock.patch.object(
                watch.Watcher, "sweep", side_effect=ConnectionResetError("closed")
            ),
            self.assertRaises(ConnectionResetError),
        ):
            await self.watcher.sweep_guarded("event")


class StartupIsNotAnExceptionToTheRule(unittest.IsolatedAsyncioTestCase):
    """The first sweep runs before the event loop, and used to escape the guard.

    launchd restarts a watcher that exits, so a startup sweep that always
    failed put the process in a loop with a 30-second delay in it, evening
    nothing the whole time.
    """

    async def run_main(self, once):
        async def nothing(*_args, **_kwargs):
            return None

        with (
            mock.patch.object(watch.iterm2, "async_get_app", side_effect=nothing),
            mock.patch.object(watch, "layout_events", side_effect=nothing),
            mock.patch.object(watch, "focus_events", side_effect=nothing),
            mock.patch.object(watch.Watcher, "run", side_effect=nothing),
            mock.patch.object(watch, "log"),
        ):
            await watch.main(object(), options(once=once))

    async def test_a_failed_startup_sweep_does_not_end_the_watcher(self):
        raised = iterm2.rpc.RPCException("WRONG_TREE")
        with mock.patch.object(watch.Watcher, "sweep", side_effect=raised):
            await self.run_main(once=False)

    async def test_once_still_reports_a_failed_sweep_to_its_caller(self):
        """`--once` turns an uncaught failure into an exit code, so it keeps it."""
        raised = iterm2.rpc.RPCException("WRONG_TREE")
        with (
            mock.patch.object(watch.Watcher, "sweep", side_effect=raised),
            self.assertRaises(iterm2.rpc.RPCException),
        ):
            await self.run_main(once=True)


class EventSchedulingTest(unittest.IsolatedAsyncioTestCase):
    async def run_stream(self, focus=False):
        watcher = watch.Watcher(object(), options(debounce=100))
        wake = asyncio.Event()
        swept = asyncio.Event()

        class SweepObserved(Exception):
            """End the fixture when its first sweep has been measured."""

        async def sweep(_reason):
            swept.set()
            raise SweepObserved

        async def stream():
            while True:
                wake.set()
                await asyncio.sleep(0.01)

        with mock.patch.object(watcher, "sweep_guarded", side_effect=sweep) as called:
            runner = asyncio.create_task(watcher.run(wake))
            producer = asyncio.create_task(stream())
            try:
                await asyncio.sleep(0.02)
                if focus:
                    watcher.focus_pending = True
                    wake.set()
                await asyncio.wait_for(swept.wait(), 0.05 if focus else 0.3)
                if focus:
                    self.assertEqual(called.call_args.args[0], "focus")
                with self.assertRaises(SweepObserved):
                    await runner
            finally:
                runner.cancel()
                producer.cancel()
                await asyncio.gather(runner, producer, return_exceptions=True)

    async def test_continuous_events_cannot_starve_a_sweep(self):
        await self.run_stream()

    async def test_focus_interrupts_an_in_progress_event_window(self):
        await self.run_stream(focus=True)


class LockCreationTest(unittest.TestCase):
    def test_incomplete_and_invalid_records_have_a_bounded_creation_grace(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            mock.patch.object(watch, "STATE_DIR", directory),
        ):
            lock = pathlib.Path(directory, "state.json.lock")
            lock.mkdir()
            owner = lock / "owner.json"
            for value in (
                "{",
                "null",
                "[]",
                "{}",
                json.dumps({"pid": True}),
                json.dumps({"pid": -1}),
            ):
                owner.write_text(value)
                os.utime(lock, None)
                self.assertTrue(watch.layout_busy(), value)
                past = time.time() - 61
                os.utime(lock, (past, past))
                self.assertFalse(watch.layout_busy(), value)

    def test_unreadable_metadata_cannot_be_mistaken_for_an_idle_layout(self):
        with (
            mock.patch("builtins.open", side_effect=PermissionError("owner denied")),
            mock.patch.object(
                watch.os, "stat", return_value=type("Stat", (), {"st_mtime": 0})()
            ),
            self.assertRaisesRegex(watch.LayoutLockError, "cannot read command lock"),
        ):
            watch.layout_busy()
        with (
            mock.patch("builtins.open", side_effect=FileNotFoundError()),
            mock.patch.object(
                watch.os, "stat", side_effect=PermissionError("lock denied")
            ),
            self.assertRaisesRegex(
                watch.LayoutLockError, "cannot inspect command lock"
            ),
        ):
            watch.layout_busy()


if __name__ == "__main__":
    unittest.main()
