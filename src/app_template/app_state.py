import logging

from pydoover.state import StateMachine

log = logging.getLogger(__name__)


class SampleState:
    state: str

    states = [
        {"name": "off", "timeout": 5, "on_timeout": "set_on"},
        {"name": "on", "timeout": 5, "on_timeout": "set_off"},
    ]

    transitions = [
        {"trigger": "set_on", "source": "off", "dest": "on"},
        {"trigger": "set_off", "source": "on", "dest": "off"},
    ]

    def __init__(self):
        self.state_machine = StateMachine(
            states=self.states,
            transitions=self.transitions,
            model=self,
            initial="off",
            queued=True,
        )

    async def on_enter_off(self):
        log.info("State changed to off!")

    async def on_enter_on(self):
        log.info("State changed to on!")
