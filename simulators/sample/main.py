import random

from pydoover.docker import Application, run_app
from pydoover.tags import Tag, Tags


class SimulatorTags(Tags):
    random_value = Tag("number", default=0)


class SampleSimulator(Application):
    tags_cls = SimulatorTags

    async def setup(self):
        pass

    async def main_loop(self):
        await self.tags.random_value.set(random.randint(1, 100))


def main():
    """Run the sample simulator application."""
    run_app(SampleSimulator())


if __name__ == "__main__":
    main()
