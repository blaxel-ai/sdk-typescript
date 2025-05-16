# Blaxel Typescript SDK

<p align="center">
  <img src="https://blaxel.ai/logo.png" alt="Blaxel"/>
</p>

**Blaxel is a computing platform for AI agent builders, with all the services and infrastructure to build and deploy agents efficiently.** This repository contains the TypeScript SDK to enable our integrated telemetry.

## Table of Contents

- [Installation](#installation)
- [Features](#features)



## Installation

Install Blaxel telemetry SDK, which lets you enable telemetry.

```bash
## npm
npm install @blaxel/telemetry

## pnpm
pnpm i @blaxel/telemetry

## yarn
yarn add @blaxel/telemetry
```


## Features
- Enable tracing : Trace are automatically sampled at 10%, and can be retrieved from the Blaxel console.


Instrumentation happens automatically when workloads run on Blaxel. To enable telemetry, simply require the SDK in your project's entry point.
```ts
import "@blaxel/telemetry";
```



## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.



## License

This project is licensed under the MIT License - see the LICENSE file for details.
