/**
 * 验证《地面站—机载0812》要求的 WebSocket 握手、遥测和控制消息。
 */

const { spawn } = require("child_process");
const http = require("http");
const WebSocket = require("ws");

const TEST_WS_PORT = 18081;
const server = spawn(process.execPath, ["server.js", "--initial-state=landed"], {
  cwd: __dirname,
  env: {
    ...process.env,
    WS_PORT: String(TEST_WS_PORT),
    FTP_PORT: "10021",
    WEBDAV_PORT: "11900",
    SIMULATED_LANDING_INTERVAL: "2000",
    SIMULATED_TAKEOFF_DELAY: "700",
    FLIGHT_TRANSITION_INTERVAL: "50",
    FLIGHT_TRANSITION_STEP: "1.5",
    SIMULATED_TAKEOFF_HEIGHT: "3",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
let client;
let finished = false;
let timeout;
let shutdownTimeout;
let webDavChecked = false;

function finish(error) {
  if (finished) {
    return;
  }
  finished = true;
  clearTimeout(timeout);
  if (client) {
    client.terminate();
  }

  if (error) {
    console.error(error);
    process.exitCode = 1;
  } else {
    console.log("WebSocket 协议集成验证通过");
  }
  server.kill("SIGTERM");
  shutdownTimeout = setTimeout(() => server.kill("SIGKILL"), 1000);
}

function startClient() {
  const expected = new Set([
    "self",
    "load",
    "base",
    "initialLanded",
    "detail",
    "unverified",
    "reply",
    "bidLifecycle",
  ]);
  let verified = false;
  let verifySent = false;
  let commandSent = false;
  let takeOffSent = false;
  let initialBid;
  let firstFlightBid;
  let landingObserved = false;

  const check = () => {
    if (expected.size === 0) {
      finish();
    }
  };

  client = new WebSocket(`ws://127.0.0.1:${TEST_WS_PORT}`);
  client.on("open", () => {
    client.send(
      JSON.stringify({
        action: "auth",
        source: "protocol-integration-test",
        username: "rkws",
        password: "qwer!@#$",
      }),
    );
  });

  client.on("message", (raw) => {
    const message = JSON.parse(raw);
    if (message.action === "auth" && message.result === "success") {
      client.send(
        JSON.stringify({
          action: "command",
          source: "protocol-integration-test",
          sn: "1F00223233510B34373435",
          devicetype: "app",
          tid: "unverified-test-tid",
          bid: "protocol-test-bid",
          method: "ledLight",
          timestamp: Date.now(),
          data: { enabled: 1 },
        }),
      );
    } else if (message.action === "verify" && message.result === "success") {
      verified = true;
    } else if (message.action === "telemetry") {
      if (message.self_check) {
        expected.delete("self");
      }
      if (message.method === "load" && message.data?.mounts?.length === 4) {
        expected.delete("load");
      }
      if (message.basic_data && message.flight_status) {
        expected.delete("base");
        if (!takeOffSent && message.flight_status.landed_state === 0) {
          expected.delete("initialLanded");
        }
        initialBid ||= message.bid;

        if (verified && !takeOffSent) {
          takeOffSent = true;
          client.send(
            JSON.stringify({
              action: "command",
              source: "protocol-integration-test",
              sn: "1F00223233510B34373435",
              devicetype: "app",
              tid: "takeoff-test-tid",
              bid: "takeoff-request-bid",
              method: "takeOff",
              timestamp: Date.now(),
              data: { height: 3 },
            }),
          );
        }

        if (
          takeOffSent &&
          [1, 3].includes(message.flight_status.landed_state) &&
          message.bid !== initialBid
        ) {
          firstFlightBid ||= message.bid;
        }
        if (
          firstFlightBid &&
          [0, 2].includes(message.flight_status.landed_state) &&
          message.bid === firstFlightBid
        ) {
          landingObserved = true;
        }
        if (
          landingObserved &&
          [1, 3].includes(message.flight_status.landed_state) &&
          message.bid !== firstFlightBid
        ) {
          expected.delete("bidLifecycle");
        }
      }
      if (
        message.perception &&
        message.position_attitude?.start_position &&
        Number.isFinite(message.remaining_flight_time) &&
        Object.hasOwn(message, "criticallyLowBattery") &&
        Object.hasOwn(message, "lowBattery")
      ) {
        expected.delete("detail");
      }
      if (firstFlightBid && !commandSent) {
        commandSent = true;
        client.send(
          JSON.stringify({
            action: "command",
            source: "protocol-integration-test",
            sn: "1F00223233510B34373435",
            devicetype: "app",
            tid: "protocol-test-tid",
            bid: "protocol-test-bid",
            method: "obstacleAvoidance",
            timestamp: Date.now(),
            data: { enabled: 1, stop: 2 },
          }),
        );
      }
    } else if (
      message.action === "command_reply" &&
      message.method === "ledLight" &&
      message.data?.result === -1
    ) {
      expected.delete("unverified");
      if (!verifySent) {
        verifySent = true;
        client.send(
          JSON.stringify({
            action: "verify",
            source: "protocol-integration-test",
            cert: "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----",
          }),
        );
      }
    } else if (
      message.action === "command_reply" &&
      message.method === "obstacleAvoidance" &&
      message.data?.result === 0 &&
      message.devicetype === "app"
    ) {
      expected.delete("reply");
    }
    check();
  });

  client.on("error", (error) => finish(error));
}

function requestWebDav(pathname) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port: 11900,
        path: pathname,
        method: "PROPFIND",
        headers: {
          Authorization: `Basic ${Buffer.from("admin:admin123").toString("base64")}`,
          Depth: "1",
        },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      },
    );
    request.on("error", reject);
    request.end();
  });
}

async function verifyWebDavRoutes() {
  const [planStatus, ssdStatus, legacyMediaStatus] = await Promise.all([
    requestWebDav("/plan"),
    requestWebDav("/ssd"),
    requestWebDav("/media"),
  ]);
  if (planStatus !== 207 || ssdStatus !== 207 || legacyMediaStatus !== 404) {
    throw new Error(
      `WebDAV 路径验证失败：/plan=${planStatus}, /ssd=${ssdStatus}, /media=${legacyMediaStatus}`,
    );
  }
}

server.stdout.on("data", (chunk) => {
  output += chunk;
  if (!webDavChecked && output.includes("[WebDAV] 服务器启动成功")) {
    webDavChecked = true;
    verifyWebDavRoutes().then(startClient).catch(finish);
  }
});

server.stderr.on("data", (chunk) => {
  output += chunk;
});

server.on("exit", (code) => {
  clearTimeout(shutdownTimeout);
  if (!finished) {
    finish(`服务启动失败（退出码 ${code}）：${output}`);
  }
});

timeout = setTimeout(() => {
  finish(`协议集成验证超时：${output}`);
}, 8000);
