import argparse
import asyncio
import unittest
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

    async def test_a_clean_sweep_still_reports_success(self):
        with mock.patch.object(watch.Watcher, "sweep", return_value=None):
            self.assertIs(await self.watcher.sweep_guarded("focus"), True)

    async def test_a_lost_connection_still_ends_the_process(self):
        """launchd restarting is the right answer to a dead connection."""
        with (
            mock.patch.object(
                watch.Watcher, "sweep", side_effect=ConnectionResetError("closed")
            ),
            self.assertRaises(ConnectionResetError),
        ):
            await self.watcher.sweep_guarded("event")


if __name__ == "__main__":
    unittest.main()
