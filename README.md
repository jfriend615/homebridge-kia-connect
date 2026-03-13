# homebridge-kia-connect

Homebridge plugin for Kia Connect vehicles.

This plugin exposes a Kia vehicle to Apple Home through Homebridge, including vehicle status sensors and a small set of remote controls.

## Features

- Vehicle status in HomeKit
- Door lock / unlock
- Remote climate start / stop
- Fuel level
- 12V battery level
- Outside temperature
- Engine running state
- Door, window, hood, and trunk sensors
- Tire pressure warning
- OTP-assisted Kia Connect authentication through the Homebridge UI

## Requirements

- Node.js `20.18.0` or newer
- Homebridge `1.8.0` or newer
- A Kia Connect account for a supported US Kia vehicle

## Installation

Install through the Homebridge UI, or with npm:

```bash
npm install -g homebridge-kia-connect
```

Then restart Homebridge.

## Configuration

The plugin is a dynamic platform and uses the following settings:

- `username`: Kia Connect email
- `password`: Kia Connect password
- `vehicleIndex`: Which vehicle to use if your account has multiple vehicles
- `pollIntervalMinutes`: Refresh interval, minimum `5`
- `enableDoorLock`: Show the HomeKit lock service
- `enableClimateControl`: Show the HomeKit climate switch

Example:

```json
{
  "platform": "KiaConnect",
  "name": "Kia Connect",
  "username": "you@example.com",
  "password": "your-password",
  "vehicleIndex": 0,
  "pollIntervalMinutes": 30,
  "enableDoorLock": true,
  "enableClimateControl": true
}
```

## Authentication / OTP

If Kia Connect requires a one-time password:

1. Open the plugin settings in Homebridge.
2. Enter your Kia Connect email and password if needed.
3. Click `Login`.
4. Choose `Email` or `SMS` for the OTP.
5. Enter the code and verify it.
6. Restart Homebridge after authentication succeeds.

## HomeKit Services

This plugin creates one accessory for the selected vehicle and can expose:

- `LockMechanism` for door lock control
- `Switch` for climate control
- `Battery` for 12V battery level
- `HumiditySensor` for fuel level
- `TemperatureSensor` for outside temperature
- `OccupancySensor` for engine running
- `ContactSensor` services for doors, windows, hood, and trunk
- `LeakSensor` for tire pressure warning

## Notes

- This plugin currently targets the US Kia Connect API.
- Climate control uses a fixed start temperature of `72F`.
- Polling is periodic and should not be set aggressively.

## Development

```bash
npm install
npm run build
npm run lint
```

Project layout:

- [src](/Users/jordanfreund/Desktop/homebridge-kia-connect/src)
- [homebridge-ui](/Users/jordanfreund/Desktop/homebridge-kia-connect/homebridge-ui)
- [config.schema.json](/Users/jordanfreund/Desktop/homebridge-kia-connect/config.schema.json)

## License

ISC
