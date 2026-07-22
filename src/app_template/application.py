import logging
import time

from pydoover.docker import Application
from pydoover import ui

from .app_config import SampleConfig
from .app_tags import SampleTags
from .app_ui import SampleUI
from .app_state import SampleState

log = logging.getLogger(__name__)


class SampleApplication(Application):
    config_cls = SampleConfig
    tags_cls = SampleTags
    ui_cls = SampleUI

    config: SampleConfig
    tags: SampleTags

    async def setup(self):
        self.started = time.time()
        self.state = SampleState()

    async def main_loop(self):
        log.info(f"State is: {self.state.state}")

        # a random value we set inside our simulator. Go check it out in simulators/sample!
        random_value = self.get_tag("random_value", self.config.sim_app_key.value)
        log.info("Random value from simulator: %s", random_value)

        await self.tags.is_working.set(True)
        await self.tags.battery_voltage.set(random_value)
        await self.tags.uptime.set(time.time() - self.started)

    @ui.handler("send_alert")
    async def on_send_alert(self, ctx, value):
        output = self.tags.test_output.get()
        log.info(f"Sending alert: {output}")
        await self.create_message("significantAlerts", {"text": output})
        await ctx.set_value(None)

    @ui.handler("test_message")
    async def on_text_parameter_change(self, ctx, value):
        log.info(f"New value for test message: {value}")
        await self.tags.test_output.set(value)

    @ui.handler("charge_mode")
    async def on_state_command(self, ctx, value):
        log.info(f"New value for state command: {value}")
