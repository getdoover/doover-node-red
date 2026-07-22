from pydoover.tags import Tag, Tags


class SampleTags(Tags):
    is_working = Tag("boolean", default=False)
    uptime = Tag("number", default=0)
    test_output = Tag("string", default="")
    battery_voltage = Tag("number", default=0)
