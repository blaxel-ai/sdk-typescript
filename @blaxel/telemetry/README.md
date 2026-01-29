# Blaxel TypeScript SDK

[Blaxel](https://blaxel.ai) is a perpetual sandbox platform that achieves near instant latency by keeping infinite secure sandboxes on automatic standby, while co-hosting your agent logic to cut network overhead.

This package contains helper functions for Blaxel's TypeScript SDK, to enable integrated telemetry.

Traces are automatically sampled at 10%, and can be retrieved from the Blaxel Console.

## Installation

```bash
# npm
npm install @blaxel/telemetry

# yarn
yarn add @blaxel/telemetry

# bun
bun add @blaxel/telemetry
```

## Authentication

The SDK authenticates with your Blaxel workspace using these sources (in priority order):

1. Blaxel CLI, when logged in
2. Environment variables in `.env` file (`BL_WORKSPACE`, `BL_API_KEY`)
3. System environment variables
4. Blaxel configuration file (`~/.blaxel/config.yaml`)

When developing locally, the recommended method is to just log in to your workspace with the Blaxel CLI:

```bash
bl login YOUR-WORKSPACE
```

This allows you to run Blaxel SDK functions that will automatically connect to your workspace without additional setup. When you deploy on Blaxel, this connection persists automatically.

When running Blaxel SDK from a remote server that is not Blaxel-hosted, we recommend using environment variables as described in the third option above.

## Usage

Enable automatic telemetry by importing the `@blaxel/telemetry` package:

```typescript
import "@blaxel/telemetry";
```

## Requirements

- Node.js v18 or later

## Contributing

Contributions are welcome! Please feel free to [submit a pull request](https://github.com/blaxel-ai/sdk-typescript/pulls).

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
