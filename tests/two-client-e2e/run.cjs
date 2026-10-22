/*
This module is the stable entrypoint for two-client end-to-end tests. It resolves a scenario module, starts a dedicated test server, and hands that scenario a reusable browser harness with two-client helpers.

Keeping this runner stable is important for repeatability and for command approval ergonomics. New test behaviors should usually be added as scenario modules so the main command stays the same even when we validate different peer-to-peer flows.
*/

const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createTwoClientHarness } = require("./harness.cjs");

const DEFAULT_SCENARIO = "friend-request-online";

const BUILT_IN_SCENARIOS = {
  "friend-request-online": path.join(
    __dirname,
    "scenarios",
    "friend-request-online.cjs"
  ),
  "reload-reconnect": path.join(
    __dirname,
    "scenarios",
    "reload-reconnect.cjs"
  ),
  "server-queue-delivery": path.join(
    __dirname,
    "scenarios",
    "server-queue-delivery.cjs"
  ),
  "trio-recovery": path.join(
    __dirname,
    "scenarios",
    "trio-recovery.cjs"
  ),
  "multiple-payment-requests": path.join(
    __dirname,
    "scenarios",
    "multiple-payment-requests.cjs"
  ),
  "wake-reconnect": path.join(
    __dirname,
    "scenarios",
    "wake-reconnect.cjs"
  ),
  "self-relay-sync": path.join(
    __dirname,
    "scenarios",
    "self-relay-sync.cjs"
  ),
  "friendship-default": path.join(
    __dirname,
    "scenarios",
    "friendship-default.cjs"
  ),
};

const parseArgs = (argv) => {
  const options = {
    scenario: DEFAULT_SCENARIO,
    port: Number(process.env.TEST_PORT) || 3001,
    host: process.env.TEST_HOST || "127.0.0.1",
    browserName: process.env.TEST_BROWSER || "chromium",
    headless: process.env.HEADED !== "1",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--scenario" && argv[index + 1]) {
      options.scenario = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--port" && argv[index + 1]) {
      options.port = Number(argv[index + 1]) || options.port;
      index += 1;
      continue;
    }
    if (value === "--host" && argv[index + 1]) {
      options.host = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--browser" && argv[index + 1]) {
      options.browserName = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--headed") {
      options.headless = false;
    }
  }

  return options;
};

const resolveScenarioPath = (scenarioOption) => {
  if (BUILT_IN_SCENARIOS[scenarioOption]) {
    return BUILT_IN_SCENARIOS[scenarioOption];
  }

  return path.resolve(process.cwd(), scenarioOption);
};

const loadScenario = async (scenarioPath) => {
  const moduleUrl = pathToFileURL(scenarioPath).href;
  const scenarioModule = await import(moduleUrl);
  return scenarioModule.default || scenarioModule;
};

const run = async () => {
  const options = parseArgs(process.argv.slice(2));
  const scenarioPath = resolveScenarioPath(options.scenario);
  const scenario = await loadScenario(scenarioPath);

  if (!scenario || typeof scenario.run !== "function") {
    throw new Error(`Scenario at ${scenarioPath} does not export a run() function`);
  }

  const harness = createTwoClientHarness({
    host: options.host,
    port: options.port,
    browserName: options.browserName,
    headless: options.headless,
  });

  try {
    await harness.startServer();
    const summary = await scenario.run({
      harness,
      assert: harness.assert,
      helpers: harness.helpers,
      createClient: harness.createClient,
      createSeededClient: harness.createSeededClient,
    });

    console.log(
      JSON.stringify(
        {
          scenario: scenario.name || options.scenario,
          browser: harness.browserName,
          server: harness.baseUrl,
          summary: summary || null,
        },
        null,
        2
      )
    );
  } finally {
    await harness.close();
  }
};

run().catch((error) => {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
