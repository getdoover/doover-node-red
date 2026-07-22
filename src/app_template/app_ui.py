from pathlib import Path

from pydoover import ui

from .app_tags import SampleTags


class SampleUI(ui.UI):
    is_working = ui.BooleanVariable("We Working?", value=SampleTags.is_working, name="is_working")
    uptime = ui.NumericVariable("Uptime", value=SampleTags.uptime, name="uptime")

    send_alert = ui.Button("Send message as alert", name="send_alert", position=1)
    text_parameter = ui.TextInput("Put in a message", name="test_message")
    test_output = ui.TextVariable("This is message we got", value=SampleTags.test_output, name="test_output")

    battery = ui.Submodule(
        "Battery Module",
        name="battery",
        children=[
            ui.NumericVariable(
                "Battery Voltage",
                value=SampleTags.battery_voltage,
                name="voltage",
                precision=2,
                ranges=[
                    ui.Range("Low", 0, 10, ui.Colour.red),
                    ui.Range("Normal", 10, 20, ui.Colour.green),
                    ui.Range("High", 20, 30, ui.Colour.blue),
                ],
            ),
            ui.FloatInput("Low Voltage Alert", name="low_voltage_alert"),
            ui.Select(
                "Charge Mode",
                name="charge_mode",
                options=[
                    ui.Option("Charge"),
                    ui.Option("Discharge"),
                    ui.Option("Idle"),
                ],
            ),
        ],
    )


def export():
    SampleUI(None, None, None).export(
        Path(__file__).parents[2] / "doover_config.json",
        "sample_application",
    )


if __name__ == "__main__":
    export()
