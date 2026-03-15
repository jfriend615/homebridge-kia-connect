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
npm install -g homebridge-kia
```

Then restart Homebridge.

## Configuration

The plugin is a dynamic platform and uses the following settings:

- `username`: Kia Connect email
- `password`: Kia Connect password
- `vehicleIndex`: Which vehicle to use if your account has multiple vehicles
- `pollIntervalMinutes`: Refresh interval, minimum `5`
- `showLock`: Show the HomeKit lock service
- `showClimate`: Show the HomeKit climate switch
- `showStatus`: Show fuel, low fuel, temperature, engine, and tire warning sensors
- `showBody`: Show door, window, hood, and trunk sensors
- `showBattery`: Show the 12V battery service

Example:

```json
{
  "platform": "KiaConnect",
  "name": "Kia Connect",
  "username": "you@example.com",
  "password": "your-password",
  "vehicleIndex": 0,
  "pollIntervalMinutes": 30,
  "showLock": true,
  "showClimate": true,
  "showStatus": true,
  "showBody": false,
  "showBattery": true
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

The plugin creates up to five accessories per vehicle:

- `${vehicleName} Lock`
- `${vehicleName} Climate`
- `${vehicleName} Status`
- `${vehicleName} Body`
- `${vehicleName} Battery`

Service groups:

- `Lock`: `LockMechanism`
- `Climate`: `Switch`
- `Status`: `HumiditySensor` for `Fuel`, `LeakSensor` for `Low Fuel Warning`, `TemperatureSensor`, `OccupancySensor`, and `LeakSensor` for `Tire Pressure Warning`
- `Body`: `ContactSensor` services for doors, windows, hood, and trunk
- `Battery`: `Battery` for `12V Battery`

## Notes

- This plugin currently targets the US Kia Connect API.
- Climate control defaults to `72°F`. Set `climateTemperature` in your config to change it.
- Polling is periodic and should not be set aggressively.
- `showBody` defaults to `false`, so body sensors are hidden unless you enable them.

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
