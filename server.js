/**
 * 无人机地面站WebSocket服务端
 * 根据地面站—机载0820遥测.doc实现
 * 2Hz(基础+飞行状态) 与 1Hz(电池、感知)；认证后发送自检和负载信息。
 */

const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");
const SimpleFtpServer = require("./ftp-server");
const SimpleWebDavServer = require("./webdav-server");
const path = require("path");
const fs = require("fs");

/**
 * 读取服务启动时的初始飞行状态。
 * 支持：--initial-state=airborne|landed、--flight-state=...、--state=...
 */
function getInitialFlightState() {
  const stateArgumentIndex = process.argv.findIndex((argument) =>
    ["--initial-state", "--flight-state", "--state"].includes(argument),
  );
  const stateArgument = process.argv.find((argument) =>
    /^(--initial-state|--flight-state|--state)=/.test(argument),
  );
  const requestedState = (
    stateArgument?.split("=", 2)[1] ||
    (stateArgumentIndex >= 0 ? process.argv[stateArgumentIndex + 1] : null) ||
    process.env.INITIAL_FLIGHT_STATE ||
    "landed"
  ).toLowerCase();

  if (["airborne", "flight", "flying"].includes(requestedState)) {
    return "airborne";
  }
  if (["landed", "ground", "grounded"].includes(requestedState)) {
    return "landed";
  }

  console.warn(
    `未知初始飞行状态 “${requestedState}”，将使用默认着陆状态。`,
  );
  return "landed";
}

const INITIAL_FLIGHT_STATE = getInitialFlightState();
const INITIAL_IS_AIRBORNE = INITIAL_FLIGHT_STATE === "airborne";

// 配置
const CONFIG = {
  WS_PORT: Number(process.env.WS_PORT) || 8081,
  AUTH_USERNAME: "rkws",
  AUTH_PASSWORD: "qwer!@#$",
  DRONE_SN: "1F00223233510B34373435",
  SOURCE: "WE0GD95PA1667168259400",
  // 频率配置
  FREQ_2HZ: 500, // 2Hz = 500ms
  FREQ_1HZ: 1000, // 1Hz = 1000ms
  SIMULATED_LANDING_INTERVAL:
    Number(process.env.SIMULATED_LANDING_INTERVAL) || 5 * 60 * 1000,
  SIMULATED_TAKEOFF_DELAY:
    Number(process.env.SIMULATED_TAKEOFF_DELAY) || 10 * 1000,
  FLIGHT_TRANSITION_INTERVAL:
    Number(process.env.FLIGHT_TRANSITION_INTERVAL) || 100,
  FLIGHT_TRANSITION_STEP:
    Number(process.env.FLIGHT_TRANSITION_STEP) || 0.5,
  SIMULATED_TAKEOFF_HEIGHT:
    Number(process.env.SIMULATED_TAKEOFF_HEIGHT) || 25,
  INITIAL_FLIGHT_STATE,
  DEFAULT_DEVICE_TYPE: "app",
  // FTP配置
  FTP_PORT: Number(process.env.FTP_PORT) || 21,
  FTP_USERNAME: "firefly",
  FTP_PASSWORD: "firefly",
  FTP_ROOT: path.join(__dirname, "ftp-data"), // FTP根目录
  // WebDAV配置（与 FTP 共用文件根目录）
  WEBDAV_PORT: Number(process.env.WEBDAV_PORT) || 1900,
  WEBDAV_USERS: {
    admin: { password: "admin123", readOnly: false },
  },
  WEBDAV_ALLOWED_ROOTS: ["plan", "ssd"],
};

// 经纬度范围配置（矩形区域）
const GEO_BOUNDS = {
  minLng: 118.823655,
  maxLng: 118.936109,
  minLat: 31.889001,
  maxLat: 31.94492,
};

/**
 * 将航向角归一化为 [0, 360)；360 度与 0 度表示同一方向。
 */
function normalizeHeading(heading) {
  const normalizedHeading = heading % 360;
  return normalizedHeading < 0 ? normalizedHeading + 360 : normalizedHeading;
}

/**
 * 同步航向与偏航角，确保 heading 为 0-360，yaw 为 -180 到 180。
 */
function setDroneHeading(heading) {
  droneState.heading = normalizeHeading(heading);
  droneState.yaw =
    droneState.heading > 180 ? droneState.heading - 360 : droneState.heading;
}

// 模拟无人机状态
const droneState = {
  // 基础数据（初始位置设为矩形中心）
  lat: (GEO_BOUNDS.minLat + GEO_BOUNDS.maxLat) / 2,
  lng: (GEO_BOUNDS.minLng + GEO_BOUNDS.maxLng) / 2,
  alt: INITIAL_IS_AIRBORNE ? 100 : 75, // 海拔高度 = 起飞点海拔(~75m) + 相对高度
  relativeHeight: INITIAL_IS_AIRBORNE ? 25 : 0,
  trueGroundHeight: INITIAL_IS_AIRBORNE ? 25 : 0, // 对地真高（与相对高度接近）
  groundSpeed: INITIAL_IS_AIRBORNE ? 10 : 0,
  verticalSpeed: 0,
  totalSpeed: INITIAL_IS_AIRBORNE ? 10 : 0,
  heading: 180,
  yaw: 180,
  pitch: 0,
  roll: 0,

  // 移动方向（用于计算经纬度变化）
  latDirection: 0,
  lngDirection: 0,

  // 速度控制目标（连续变化）
  targetGroundSpeed: 10,
  targetRelativeHeight: 25,

  // 起飞点海拔高度（用于计算绝对海拔）
  homeAlt: 75,

  // 飞行状态
  // 协议中时间单位均为秒
  remainingFlightTime: 1080,
  remainingFlightSoc: 87,
  flightTime: 0,
  flightDistance: 0,
  criticallyLowBattery: 15,
  lowBattery: 20,
  landedState: INITIAL_IS_AIRBORNE ? 1 : 0, // 0-着陆，1-空中，2-正在着陆，3-正在起飞
  mode: "定点模式",
  lock: !INITIAL_IS_AIRBORNE,
  currentWaypointSeq: 3,

  // 云台角度
  gimbalPitch: -5.88,
  gimbalYaw: 1.4,
  gimbalRoll: -12.21,
  losPitch: 0,

  // 感知数据
  obstacleAvoidance: true,
  terrainFollowing: true,
  visionLanding: true,
  targetHeight: 50,

  // 电池
  battery1_soc: 87,
  battery2_soc: 87,
  battery1_soh: 95,
  battery2_soh: 95,
  battery1_cycle: 150,
  battery2_cycle: 150,
  battery1_capacity: 50,
  battery2_capacity: 50,
  battery1_total_voltage: 30,
  battery2_total_voltage: 30,

  // 飞行限制及进阶控制
  flightLimits: {
    returnFlightAltitude: 50,
    heightEnabled: false,
    heightLimit: 120,
    distanceEnabled: false,
    distanceLimit: 3000,
    takeoffAltitude: 20,
    takeoffSpeed: 5,
  },
  advancedLimits: {
    lossOfContact: 0,
    returnPointBehavior: 0,
    joystickMode: 0,
  },
  obstacleStopStrategy: 2,
  recordingCameras: new Set(),
  recordingStartedAt: null,
  cameraControl: {
    sensorId: 0,
    focusDir: 0,
    laserAction: 0,
    model: "SG-2100",
  },
  downLedEnabled: true,

  // 任务信息
  currentBid: uuidv4(),
  currentTid: null,
};

// 飞控板类型
const SERIAL_NUMBER = "1581F6M1234567";
const FIRMWARE_VERSION = "v01.02.03";

/**
 * 更新无人机位置（在矩形范围内连续随机移动）
 * 速度控制在 5-20 m/s，相对高度控制在 5-60 m
 */
function updateDronePosition() {
  // 起飞和降落阶段由状态转换逻辑更新；已着陆时保持静止。
  if (droneState.landedState !== 1) {
    return;
  }

  // ========== 速度控制 (5-20 m/s) ==========
  // 目标速度缓慢漂移
  droneState.targetGroundSpeed += (Math.random() - 0.5) * 1.0;
  droneState.targetGroundSpeed = Math.max(
    5,
    Math.min(20, droneState.targetGroundSpeed),
  );

  // 实际速度平滑趋近目标速度
  droneState.groundSpeed +=
    (droneState.targetGroundSpeed - droneState.groundSpeed) * 0.1;
  droneState.groundSpeed = Math.max(5, Math.min(20, droneState.groundSpeed));

  // ========== 高度控制 (5-60 m) ==========
  // 目标高度缓慢漂移
  droneState.targetRelativeHeight += (Math.random() - 0.5) * 2.0;
  droneState.targetRelativeHeight = Math.max(
    5,
    Math.min(60, droneState.targetRelativeHeight),
  );

  // 实际高度平滑趋近目标高度
  const heightDiff =
    droneState.targetRelativeHeight - droneState.relativeHeight;
  droneState.verticalSpeed = heightDiff * 0.05; // 垂直速度由高度差决定
  droneState.verticalSpeed = Math.max(
    -2,
    Math.min(2, droneState.verticalSpeed),
  ); // 限制垂直速度 ±2 m/s
  droneState.relativeHeight += droneState.verticalSpeed;

  // 合速度由水平速度和垂直速度计算
  droneState.totalSpeed = Math.hypot(
    droneState.groundSpeed,
    droneState.verticalSpeed,
  );

  // 海拔高度 = 起飞点海拔 + 相对高度
  droneState.alt = droneState.homeAlt + droneState.relativeHeight;

  // 对地真高（模拟地形变化，与相对高度有小偏差）
  droneState.trueGroundHeight =
    droneState.relativeHeight + (Math.random() - 0.5) * 2;
  droneState.trueGroundHeight = Math.max(0, droneState.trueGroundHeight);

  // ========== 航向控制（缓慢转向）==========
  setDroneHeading(droneState.heading + (Math.random() - 0.5) * 5);

  // ========== 俯仰和横滚（与运动相关）==========
  // 速度变化时产生俯仰角
  droneState.pitch =
    (droneState.targetGroundSpeed - droneState.groundSpeed) * 0.5 +
    (Math.random() - 0.5) * 20;
  droneState.pitch = Math.max(-10, Math.min(10, droneState.pitch));

  // 转向时产生横滚角
  droneState.roll = (Math.random() - 0.5) * 4;
  droneState.roll = Math.max(-10, Math.min(10, droneState.roll));

  // ========== 计算经纬度变化 ==========
  // 根据航向和速度计算方向向量
  const headingRad = (droneState.heading * Math.PI) / 180;
  // 放大步长系数（原值约0.000003，放大到0.00003，加快移动速度）
  const speedFactor = 0.00003;

  // 纬度变化（北向分量）
  droneState.latDirection =
    Math.cos(headingRad) * droneState.groundSpeed * speedFactor;
  // 经度变化（东向分量，需要除以cos纬度修正）
  droneState.lngDirection =
    (Math.sin(headingRad) * droneState.groundSpeed * speedFactor) /
    Math.cos((droneState.lat * Math.PI) / 180);

  // 更新位置
  droneState.lat += droneState.latDirection;
  droneState.lng += droneState.lngDirection;

  // ========== 边界检测和随机转向 ==========
  // 安全边距（约50米，约0.00045度）
  const safeMargin = 0.00045;

  // 检测是否接近边界
  const nearLatMin = droneState.lat < GEO_BOUNDS.minLat + safeMargin;
  const nearLatMax = droneState.lat > GEO_BOUNDS.maxLat - safeMargin;
  const nearLngMin = droneState.lng < GEO_BOUNDS.minLng + safeMargin;
  const nearLngMax = droneState.lng > GEO_BOUNDS.maxLng - safeMargin;

  // 接近边界时随机换向
  if (nearLatMin || nearLatMax || nearLngMin || nearLngMax) {
    let newHeading;

    // 根据接近的边界确定安全方向范围
    if (nearLatMin && nearLngMin) {
      // 左下角：转向东北方向 (0-90度)
      newHeading = Math.random() * 90;
    } else if (nearLatMin && nearLngMax) {
      // 右下角：转向西北方向 (270-360度)
      newHeading = 270 + Math.random() * 90;
    } else if (nearLatMax && nearLngMin) {
      // 左上角：转向东南方向 (90-180度)
      newHeading = 90 + Math.random() * 90;
    } else if (nearLatMax && nearLngMax) {
      // 右上角：转向西南方向 (180-270度)
      newHeading = 180 + Math.random() * 90;
    } else if (nearLatMin) {
      // 接近南边界：转向北方 (315-45度，跨越0度)
      newHeading =
        Math.random() < 0.5 ? Math.random() * 45 : 315 + Math.random() * 45;
    } else if (nearLatMax) {
      // 接近北边界：转向南方 (135-225度)
      newHeading = 135 + Math.random() * 90;
    } else if (nearLngMin) {
      // 接近西边界：转向东方 (45-135度)
      newHeading = 45 + Math.random() * 90;
    } else if (nearLngMax) {
      // 接近东边界：转向西方 (225-315度)
      newHeading = 225 + Math.random() * 90;
    }

    setDroneHeading(newHeading);
  }

  // 强制边界保护（确保不超出范围）
  droneState.lat = Math.max(
    GEO_BOUNDS.minLat,
    Math.min(GEO_BOUNDS.maxLat, droneState.lat),
  );
  droneState.lng = Math.max(
    GEO_BOUNDS.minLng,
    Math.min(GEO_BOUNDS.maxLng, droneState.lng),
  );

  // ========== 合速度 ==========
  droneState.totalSpeed = Math.sqrt(
    Math.pow(droneState.groundSpeed, 2) + Math.pow(droneState.verticalSpeed, 2),
  );

  // ========== 云台角度（缓慢变化）==========
  droneState.gimbalPitch += (Math.random() - 0.5) * 0.5;
  droneState.gimbalPitch = Math.max(-90, Math.min(30, droneState.gimbalPitch));
  droneState.gimbalYaw += (Math.random() - 0.5) * 0.3;
  droneState.gimbalYaw = Math.max(-180, Math.min(180, droneState.gimbalYaw));
  droneState.gimbalRoll += (Math.random() - 0.5) * 0.2;
  droneState.gimbalRoll = Math.max(-30, Math.min(30, droneState.gimbalRoll));

  // ========== 剩余飞行时间估算 ==========
  const elapsedSeconds = CONFIG.FREQ_2HZ / 1000;
  droneState.remainingFlightTime = Math.max(
    0,
    droneState.remainingFlightTime - elapsedSeconds,
  );
  droneState.remainingFlightSoc = Math.max(
    0,
    parseFloat((droneState.battery1_soc - 0.5).toFixed(1)),
  );
  droneState.flightTime += elapsedSeconds;
  droneState.flightDistance += droneState.groundSpeed * elapsedSeconds;
}

/**
 * 生成公共消息头
 */
function createMessageHeader(method) {
  return {
    action: "telemetry",
    source: CONFIG.SOURCE,
    sn: CONFIG.DRONE_SN,
    tid: uuidv4(),
    bid: droneState.currentBid,
    method,
    timestamp: Date.now(),
  };
}

/**
 * 2Hz数据: 基础数据 + 飞行状态
 */
function generate2HzData() {
  updateDronePosition();

  return {
    ...createMessageHeader("realtimeData"),
    basic_data: {
      lat: parseFloat(droneState.lat.toFixed(6)),
      lng: parseFloat(droneState.lng.toFixed(6)),
      alt: parseFloat(droneState.alt.toFixed(1)),
      relative_height: parseFloat(droneState.relativeHeight.toFixed(1)),
      true_ground_height: parseFloat(droneState.trueGroundHeight.toFixed(1)),
      ground_speed: parseFloat(droneState.groundSpeed.toFixed(1)),
      vertical_speed: parseFloat(droneState.verticalSpeed.toFixed(2)),
      total_speed: parseFloat(droneState.totalSpeed.toFixed(1)),
      heading: parseFloat(droneState.heading.toFixed(1)),
      yaw: parseFloat(droneState.yaw.toFixed(1)),
      pitch: parseFloat(droneState.pitch.toFixed(1)),
      roll: parseFloat(droneState.roll.toFixed(1)),
    },
    flight_status: {
      landed_state: droneState.landedState,
      mode: droneState.mode,
      lock: droneState.lock,
      serial_number: SERIAL_NUMBER,
      firmware_version: FIRMWARE_VERSION,
      current_waypoint_seq: droneState.currentWaypointSeq,
    },
  };
}

/**
 * 1Hz数据: 感知、系统状态、飞行信息与云台信息
 */
function generate1HzData() {
  return {
    ...createMessageHeader("realtimeData"),
    perception: {
      obstacle_avoidance: {
        enabled: droneState.obstacleAvoidance,
        obstacles: [
          {
            direction: "front",
            distance: parseFloat((5.2 + Math.random() * 3).toFixed(1)),
          },
          {
            direction: "left_front",
            distance: parseFloat((4.8 + Math.random() * 3).toFixed(1)),
          },
          {
            direction: "right_front",
            distance: parseFloat((4.5 + Math.random() * 3).toFixed(1)),
          },
          {
            direction: "left",
            distance: parseFloat((3.8 + Math.random() * 3).toFixed(1)),
          },
          {
            direction: "right",
            distance: parseFloat((4.2 + Math.random() * 3).toFixed(1)),
          },
          {
            direction: "back",
            distance: parseFloat((6.5 + Math.random() * 3).toFixed(1)),
          },
        ],
      },
      terrain_following: {
        enabled: droneState.terrainFollowing,
        target_height: droneState.targetRelativeHeight,
        current_height: parseFloat(droneState.relativeHeight.toFixed(1)),
      },
      vision_landing: {
        enabled: droneState.visionLanding,
        qr_code_detected: false,
      },
      sbus_joystick: {
        throttle: 0,
        yaw: 0,
        pitch: 0,
        roll: 0,
      },
      front_mmwave_radar: {
        distance: parseFloat((15.3 + Math.random() * 5).toFixed(1)),
      },
      downward_mmwave_radar: {
        height: parseFloat(droneState.trueGroundHeight.toFixed(1)),
      },
    },
    position_attitude: {
      satellite_count: 16,
      gps_signal_level: 4,
      cros_connected: false,
      true_ground_height: parseFloat(droneState.trueGroundHeight.toFixed(1)),
      start_position: {
        lat: parseFloat(
          ((GEO_BOUNDS.minLat + GEO_BOUNDS.maxLat) / 2).toFixed(6),
        ),
        lng: parseFloat(
          ((GEO_BOUNDS.minLng + GEO_BOUNDS.maxLng) / 2).toFixed(6),
        ),
        alt: droneState.homeAlt,
      },
    },
    communication: {
      video_transmission: {
        node_type: "master",
        snr: parseFloat((28.5 + Math.random() * 5).toFixed(1)),
        rsrp: parseFloat((-75.2 + Math.random() * 10).toFixed(1)),
        frequency: 5800,
        encryption_key: "",
      },
      cellular_5g: {
        active_sim: 1,
        signal_strength: Math.round(Math.random() * 31),
      },
    },
    avionics: {
      temperatures: {
        chip_a: parseFloat((65.5 + Math.random() * 5).toFixed(1)),
        chip_b: parseFloat((58.2 + Math.random() * 5).toFixed(1)),
        chip_c: parseFloat((62.3 + Math.random() * 5).toFixed(1)),
      },
      humidity: 65.8,
      cpu_usage: parseFloat((45.2 + Math.random() * 10).toFixed(1)),
      emmc_used_gb: 68.5,
      emmc_free_gb: 32,
      ssd_used_gb: 30,
      ssd_free_gb: 40,
      motors: [
        {
          id: 1,
          speed: Math.round(5200 + Math.random() * 200),
          voltage: 24.5,
          current: parseFloat((12.5 + Math.random() * 2).toFixed(1)),
          temperature: parseFloat((52.3 + Math.random() * 5).toFixed(1)),
        },
        {
          id: 2,
          speed: Math.round(5180 + Math.random() * 200),
          voltage: 24.5,
          current: parseFloat((12.3 + Math.random() * 2).toFixed(1)),
          temperature: parseFloat((51.8 + Math.random() * 5).toFixed(1)),
        },
        {
          id: 3,
          speed: Math.round(5210 + Math.random() * 200),
          voltage: 24.5,
          current: parseFloat((12.6 + Math.random() * 2).toFixed(1)),
          temperature: parseFloat((52.5 + Math.random() * 5).toFixed(1)),
        },
        {
          id: 4,
          speed: Math.round(5190 + Math.random() * 200),
          voltage: 24.5,
          current: parseFloat((12.4 + Math.random() * 2).toFixed(1)),
          temperature: parseFloat((52 + Math.random() * 5).toFixed(1)),
        },
      ],
      total_power: 1250.5,
    },
    battery_system: {
      battery1: {
        sn: "12345678",
        current: parseFloat((12.5 + Math.random() * 2).toFixed(1)),
        hardware_version: "1.0",
        software_version: "1.0",
        capacity: droneState.battery1_capacity,
        total_voltage: droneState.battery1_total_voltage,
        cell_voltages: [
          3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 4, 4.1, 4.2, 4.3,
        ],
        soc: droneState.battery1_soc,
        soh: droneState.battery1_soh,
        cycle: droneState.battery1_cycle,
        temperatures: { mos: 45.2, cell: 38.5, connector: 42.3 },
        state: { ready: true, discharge: false, charge: true },
        protections: {
          over_voltage: false,
          under_voltage: false,
          over_temp: false,
          under_temp: false,
          charge_over_current: false,
          discharge_over_current: true,
          short_circuit: false,
        },
        discharge_day: 30,
        ready_flag: true,
      },
      battery2: {
        sn: "12345678",
        current: parseFloat((12.5 + Math.random() * 2).toFixed(1)),
        hardware_version: "1.0",
        software_version: "1.0",
        capacity: droneState.battery2_capacity,
        total_voltage: droneState.battery2_total_voltage,
        cell_voltages: [
          3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 4, 4.1, 4.2, 4.3,
        ],
        soc: droneState.battery2_soc,
        soh: droneState.battery2_soh,
        cycle: droneState.battery2_cycle,
        temperatures: { mos: 44.8, cell: 37.9, connector: 41.5 },
        state: { ready: true, discharge: true, charge: false },
        protections: {
          over_voltage: false,
          under_voltage: false,
          over_temp: false,
          under_temp: false,
          charge_over_current: false,
          discharge_over_current: false,
          short_circuit: false,
        },
        discharge_day: 28,
        ready_flag: true,
      },
    },
    power_modules: {
      typec1_vol: 24500,
      typec2_vol: 0,
      typec1_cur: 3200,
      typec2_cur: 0,
      local_voltage: 24.5,
      load_current: -3.2,
      fan_speed: 1500,
      load_state_data: 1,
      ladar_power: true,
      ld0_power: true,
      ld1_power: false,
      switch_power: true,
      typec_high_power: true,
      rk3588_power: true,
      typec1_high_power: true,
      typec1_low_power: false,
      typec2_high_power: true,
      typec2_low_power: false,
      view_12v_power: true,
      fc_power: true,
      fan_power: true,
      down_led_power: droneState.downLedEnabled,
      down_led_state: droneState.downLedEnabled,
      load1_state: 1,
      load2_state: 0,
    },
    network_status: {
      load_ip: "192.168.1.100",
      load1_ip: "192.168.1.101",
      load2_ip: "192.168.1.102",
    },
    hall_sensors: {
      hall1_state: false,
      hall2_state: true,
    },
    flight_info: {
      remaining_flight_time: parseFloat(
        droneState.remainingFlightTime.toFixed(1),
      ),
      remaining_flight_soc: droneState.remainingFlightSoc,
      criticallyLowBattery: droneState.criticallyLowBattery,
      lowBattery: droneState.lowBattery,
      flight_time: parseFloat(droneState.flightTime.toFixed(1)),
      flight_distance: parseFloat(droneState.flightDistance.toFixed(1)),
    },
    gimbal_angle: {
      los_pitch: droneState.losPitch,
      gimbal_pitch: parseFloat(droneState.gimbalPitch.toFixed(5)),
      gimbal_yaw: parseFloat(droneState.gimbalYaw.toFixed(5)),
      gimbal_roll: parseFloat(droneState.gimbalRoll.toFixed(5)),
    },
    gimbal_info: {
      record_status: droneState.recordingCameras.size > 0 ? 1 : 0,
      record_duration: droneState.recordingStartedAt
        ? Date.now() - droneState.recordingStartedAt
        : 0,
      laser_distance: 0,
    },
  };
}

/**
 * 1/30Hz数据: 飞行器自检
 */
function generateSelfCheckData() {
  return {
    ...createMessageHeader("selfCheckData"),
    self_check: {
      overall: 1,
      items: {
        power_system: 0,
        avionics_system: 0,
        perception_system: 0,
        log_management: 0,
        battery_system: 0,
        remote_controller: 0,
        video_transmission: 0,
        registration_info: 0,
      },
    },
  };
}

/**
 * 飞行器负载信息。协议要求认证后发送，并在负载信息变更时重新发送。
 */
function generateLoadData() {
  return {
    ...createMessageHeader("load"),
    data: {
      mounts: [
        {
          mountId: 1,
          deviceType: "pod",
          brand: "森云",
          model: "SG-2100",
          enabled: 1,
        },
        {
          mountId: 2,
          deviceType: "megaphone",
          brand: "XX",
          model: "XXX",
          enabled: 1,
        },
        {
          mountId: 3,
          deviceType: "searchlight",
          brand: "XX",
          model: "XXX",
          enabled: 0,
        },
        {
          mountId: 4,
          deviceType: "cast",
          brand: "XX",
          model: "XXX",
          enabled: 1,
        },
      ],
    },
  };
}

// WebSocket服务器
const wss = new WebSocket.Server({ port: CONFIG.WS_PORT });

// 已认证的客户端
const authenticatedClients = new Set();

// 定时器
let timer2Hz = null;
let timer1Hz = null;
let simulatedLandingTimer = null;
let simulatedTakeOffTimer = null;
let takeOffTimer = null;
let landTimer = null;

console.log(`无人机地面站WebSocket服务端启动`);
console.log(`监听端口: ${CONFIG.WS_PORT}`);
console.log(`认证用户名: ${CONFIG.AUTH_USERNAME}`);
console.log(`认证密码: ${CONFIG.AUTH_PASSWORD}`);
console.log(
  `初始飞行状态: ${
    CONFIG.INITIAL_FLIGHT_STATE === "airborne" ? "飞行中" : "已着陆"
  }`,
);
console.log(`数据频率: 2Hz(基础), 1Hz(感知), 认证后发送自检和负载信息`);
console.log("---");

// 启动FTP服务
const ftpServer = startFtpServer();
const webDavServer = startWebDavServer();

wss.on("connection", (ws) => {
  console.log("新客户端连接");

  ws.isAuthenticated = false;
  ws.isVerified = false;
  ws.deviceType = CONFIG.DEFAULT_DEVICE_TYPE;

  ws.on("message", (data) => {
    try {
      const message = JSON.parse(data);
      console.log("收到消息:", JSON.stringify(message, null, 2));

      // 处理认证请求
      if (message.action === "auth") {
        handleAuth(ws, message);
      }
      // 处理验签请求
      else if (message.action === "verify") {
        handleVerify(ws, message);
      }
      // 处理命令请求
      else if (message.action === "command" && message.method) {
        handleCommand(ws, message);
      }
    } catch (error) {
      console.error("消息处理错误:", error);
    }
  });

  ws.on("close", () => {
    console.log("客户端断开连接");
    authenticatedClients.delete(ws);
    if (authenticatedClients.size === 0) {
      stopTelemetry();
    }
  });

  ws.on("error", (error) => {
    console.error("WebSocket错误:", error);
  });
});

/**
 * 处理认证请求
 */
function handleAuth(ws, message) {
  const { source, username, password } = message;

  if (username === CONFIG.AUTH_USERNAME && password === CONFIG.AUTH_PASSWORD) {
    ws.isAuthenticated = true;
    ws.isVerified = false;
    ws.source = source;

    const response = {
      action: "auth",
      source,
      result: "success",
    };

    ws.send(JSON.stringify(response));
    console.log("认证成功:", source);

    // 添加到已认证客户端
    authenticatedClients.add(ws);

    // 认证后立即发送协议要求的一次性自检和负载信息。
    ws.send(JSON.stringify(generateSelfCheckData()));
    ws.send(JSON.stringify(generateLoadData()));

    // 如果是第一个认证客户端，开始发送周期遥测数据。
    if (authenticatedClients.size === 1) {
      startTelemetry();
    }
  } else {
    const response = {
      action: "auth",
      source,
      result: "fail",
      reason: "用户名或密码错误",
    };

    ws.send(JSON.stringify(response));
    console.log("认证失败:", source);
  }
}

/**
 * 处理验签请求
 */
function handleVerify(ws, message) {
  const { source, cert } = message;

  if (!ws.isAuthenticated) {
    ws.send(
      JSON.stringify({
        action: "verify",
        source,
        result: "fail",
        reason: "请先完成认证",
      }),
    );
    return;
  }

  // Mock验签逻辑：只要提供了证书就验证通过
  if (cert && cert.includes("BEGIN CERTIFICATE")) {
    ws.isVerified = true;
    const response = {
      action: "verify",
      source,
      result: "success",
    };

    ws.send(JSON.stringify(response));
    console.log("验签成功:", source);
  } else {
    ws.isVerified = false;
    const response = {
      action: "verify",
      source,
      result: "fail",
      reason: "证书格式错误或无效",
    };

    ws.send(JSON.stringify(response));
    console.log("验签失败:", source);
  }
}

/**
 * 处理命令请求
 */
function handleCommand(ws, message) {
  const { tid, bid, method, data } = message;

  ws.deviceType =
    message.devicetype || ws.deviceType || CONFIG.DEFAULT_DEVICE_TYPE;

  if (!ws.isAuthenticated || !ws.isVerified) {
    sendCommandReply(ws, tid, bid, method, -1, "请先完成认证和证书验签");
    return;
  }

  droneState.currentTid = tid;

  console.log(`收到命令: ${method}, tid: ${tid}, bid: ${bid}`);

  switch (method) {
    case "unlock":
      handleUnlock(ws, tid, bid);
      break;
    case "lock":
      handleLock(ws, tid, bid);
      break;
    case "takeOff":
      handleTakeOff(ws, tid, bid, data);
      break;
    case "backHome":
      handleBackHome(ws, tid, bid);
      break;
    case "land":
      handleLand(ws, tid, bid, data);
      break;
    case "stop":
      handleStop(ws, tid, bid);
      break;
    case "pointFly":
      handlePointFly(ws, tid, bid, data);
      break;
    case "droneControl":
      handleDroneControl(ws, tid, bid, data);
      break;
    case "airplaneMode":
      handleAirplaneMode(ws, tid, bid, data);
      break;
    case "routeFly":
      handleRouteFly(ws, tid, bid, data);
      break;
    case "continueFly":
      handleContinueFly(ws, tid, bid);
      break;
    case "waypointJump":
      handleWaypointJump(ws, tid, bid, data);
      break;
    case "setCustomBatteryAlarm":
      handleSetCustomBatteryAlarm(ws, tid, bid, data);
      break;
    case "setFlightLimits":
      handleSetFlightLimits(ws, tid, bid, data);
      break;
    case "obstacleAvoidance":
      handleObstacleAvoidance(ws, tid, bid, data);
      break;
    case "setAdvancedLimits":
      handleSetAdvancedLimits(ws, tid, bid, data);
      break;
    case "takePhoto":
      handleTakePhoto(ws, tid, bid, data);
      break;
    case "startVideo":
      handleStartVideo(ws, tid, bid, data);
      break;
    case "endVideo":
      handleEndVideo(ws, tid, bid, data);
      break;
    case "gimbalControl":
      handleGimbalControl(ws, tid, bid, data);
      break;
    case "cameraControl":
      handleCameraControl(ws, tid, bid, data);
      break;
    case "ledLight":
      handleLedLight(ws, tid, bid, data);
      break;
    case "smartFlight":
      handleSmartFlight(ws, tid, bid, data);
      break;
    default:
      console.log(`未知命令: ${method}`);
      sendCommandReply(ws, tid, bid, method, -1, `未知命令: ${method}`);
  }
}

/**
 * 发送命令回复
 */
function sendCommandReply(
  ws,
  tid,
  bid,
  method,
  result = 0,
  message = "执行成功",
) {
  const reply = {
    action: "command_reply",
    source: CONFIG.SOURCE,
    sn: CONFIG.DRONE_SN,
    devicetype: ws.deviceType || CONFIG.DEFAULT_DEVICE_TYPE,
    tid,
    bid,
    method,
    timestamp: Date.now(),
    data: {
      result,
      message,
    },
  };
  ws.send(JSON.stringify(reply));
}

/**
 * 开始一次新的飞行任务。bid 仅在此处更新，并在本次飞行的遥测中保持不变。
 */
function startTakeOff(targetHeight) {
  clearInterval(landTimer);
  clearInterval(takeOffTimer);

  droneState.currentBid = uuidv4();
  droneState.landedState = 3;
  droneState.lock = false;
  droneState.targetRelativeHeight = targetHeight;

  takeOffTimer = setInterval(() => {
    if (droneState.relativeHeight < targetHeight) {
      droneState.relativeHeight = Math.min(
        targetHeight,
        droneState.relativeHeight + CONFIG.FLIGHT_TRANSITION_STEP,
      );
      droneState.verticalSpeed = CONFIG.FLIGHT_TRANSITION_STEP /
        (CONFIG.FLIGHT_TRANSITION_INTERVAL / 1000);
      droneState.alt = droneState.homeAlt + droneState.relativeHeight;
      droneState.trueGroundHeight = droneState.relativeHeight;
      return;
    }

    droneState.landedState = 1;
    droneState.verticalSpeed = 0;
    clearInterval(takeOffTimer);
    takeOffTimer = null;
    console.log(`起飞完成，新的飞行任务 bid: ${droneState.currentBid}`);
  }, CONFIG.FLIGHT_TRANSITION_INTERVAL);
}

/**
 * 降落不会修改 bid；它会保留到下一次起飞创建新任务为止。
 */
function startLanding(landHeight, onComplete) {
  clearInterval(takeOffTimer);
  clearInterval(landTimer);

  droneState.landedState = 2;
  landTimer = setInterval(() => {
    if (droneState.relativeHeight > landHeight) {
      droneState.relativeHeight = Math.max(
        landHeight,
        droneState.relativeHeight - CONFIG.FLIGHT_TRANSITION_STEP,
      );
      droneState.verticalSpeed = -CONFIG.FLIGHT_TRANSITION_STEP /
        (CONFIG.FLIGHT_TRANSITION_INTERVAL / 1000);
      droneState.alt = droneState.homeAlt + droneState.relativeHeight;
      droneState.trueGroundHeight = droneState.relativeHeight;
      return;
    }

    droneState.landedState = 0;
    droneState.groundSpeed = 0;
    droneState.verticalSpeed = 0;
    droneState.totalSpeed = 0;
    droneState.relativeHeight = landHeight;
    droneState.alt = droneState.homeAlt + landHeight;
    droneState.trueGroundHeight = landHeight;
    clearInterval(landTimer);
    landTimer = null;
    console.log(`降落完成，飞行任务 bid 保持为: ${droneState.currentBid}`);
    onComplete?.();
  }, CONFIG.FLIGHT_TRANSITION_INTERVAL);
}

/**
 * 周期性模拟降落，并在停留后自动起飞以便持续演示完整的飞行任务生命周期。
 */
function startSimulatedLandingScenario() {
  if (simulatedLandingTimer) {
    return;
  }

  simulatedLandingTimer = setInterval(() => {
    if (droneState.landedState !== 1) {
      return;
    }

    console.log("开始周期性模拟降落场景");
    startLanding(0, () => {
      simulatedTakeOffTimer = setTimeout(() => {
        if (droneState.landedState === 0) {
          console.log("模拟降落完成，开始下一次模拟起飞");
          startTakeOff(CONFIG.SIMULATED_TAKEOFF_HEIGHT);
        }
      }, CONFIG.SIMULATED_TAKEOFF_DELAY);
    });
  }, CONFIG.SIMULATED_LANDING_INTERVAL);
}

function stopSimulatedLandingScenario() {
  clearInterval(simulatedLandingTimer);
  clearTimeout(simulatedTakeOffTimer);
  simulatedLandingTimer = null;
  simulatedTakeOffTimer = null;
}

/**
 * 解锁命令
 */
function handleUnlock(ws, tid, bid) {
  droneState.lock = false;
  console.log("无人机解锁");
  sendCommandReply(ws, tid, bid, "unlock", 0, "解锁成功");
}

/**
 * 上锁命令
 */
function handleLock(ws, tid, bid) {
  droneState.lock = true;
  console.log("无人机上锁");
  sendCommandReply(ws, tid, bid, "lock", 0, "上锁成功");
}

/**
 * 起飞命令
 */
function handleTakeOff(ws, tid, bid, data) {
  const targetHeight = Number(data?.height);
  if (!Number.isFinite(targetHeight) || targetHeight <= 0) {
    sendCommandReply(ws, tid, bid, "takeOff", -1, "起飞高度必须为大于 0 的有效数值");
    return;
  }
  if (droneState.landedState !== 0) {
    sendCommandReply(ws, tid, bid, "takeOff", -1, "飞行器当前不处于着陆状态");
    return;
  }

  clearTimeout(simulatedTakeOffTimer);
  console.log(`无人机起飞，目标高度: ${targetHeight}m`);

  startTakeOff(targetHeight);

  sendCommandReply(ws, tid, bid, "takeOff", 0, "起飞命令已接收");
}

/**
 * 返航命令
 */
function handleBackHome(ws, tid, bid) {
  console.log("无人机返航");
  droneState.mode = "自动返航模式";
  droneState.landedState = 1;
  sendCommandReply(ws, tid, bid, "backHome", 0, "返航命令已接收");
}

/**
 * 降落命令
 */
function handleLand(ws, tid, bid, data) {
  const landHeight = Number(data?.landHeight ?? 0);
  if (!Number.isFinite(landHeight) || landHeight < 0) {
    sendCommandReply(ws, tid, bid, "land", -1, "降落高度必须为非负有效数值");
    return;
  }
  if (droneState.landedState === 0) {
    sendCommandReply(ws, tid, bid, "land", -1, "飞行器当前已着陆");
    return;
  }
  clearTimeout(simulatedTakeOffTimer);
  console.log(`无人机降落，目标高度: ${landHeight}m`);

  startLanding(landHeight);

  sendCommandReply(ws, tid, bid, "land", 0, "降落命令已接收");
}

/**
 * 悬停命令
 */
function handleStop(ws, tid, bid) {
  console.log("无人机悬停");
  droneState.groundSpeed = 0;
  droneState.verticalSpeed = 0;
  droneState.totalSpeed = 0;
  droneState.latDirection = 0;
  droneState.lngDirection = 0;
  sendCommandReply(ws, tid, bid, "stop", 0, "悬停命令已接收");
}

/**
 * 点指飞行命令
 */
function handlePointFly(ws, tid, bid, data) {
  const { longitude, latitude, height } = data || {};
  if (
    !Number.isFinite(Number(longitude)) ||
    !Number.isFinite(Number(latitude)) ||
    !Number.isFinite(Number(height))
  ) {
    sendCommandReply(
      ws,
      tid,
      bid,
      "pointFly",
      -1,
      "经度、纬度和高度必须为有效数值",
    );
    return;
  }
  console.log(`指点飞行: 经度=${longitude}, 纬度=${latitude}, 高度=${height}m`);

  const targetLat = parseFloat(latitude);
  const targetLng = parseFloat(longitude);
  const targetHeight = height;

  const moveInterval = setInterval(() => {
    const latDiff = targetLat - droneState.lat;
    const lngDiff = targetLng - droneState.lng;
    const heightDiff = targetHeight - droneState.relativeHeight;

    if (
      Math.abs(latDiff) > 0.00001 ||
      Math.abs(lngDiff) > 0.00001 ||
      Math.abs(heightDiff) > 0.5
    ) {
      droneState.lat += latDiff * 0.01;
      droneState.lng += lngDiff * 0.01;
      droneState.relativeHeight += heightDiff * 0.01;
      droneState.alt += heightDiff * 0.01;
      droneState.groundSpeed = 5;
      droneState.verticalSpeed = heightDiff > 0 ? 0.5 : -0.5;
      droneState.totalSpeed = Math.sqrt(
        Math.pow(droneState.groundSpeed, 2) +
          Math.pow(droneState.verticalSpeed, 2),
      );
      setDroneHeading((Math.atan2(lngDiff, latDiff) * 180) / Math.PI);
    } else {
      droneState.lat = targetLat;
      droneState.lng = targetLng;
      droneState.relativeHeight = targetHeight;
      droneState.groundSpeed = 0;
      droneState.verticalSpeed = 0;
      droneState.totalSpeed = 0;
      clearInterval(moveInterval);
      console.log("到达目标点");
    }
  }, 100);

  sendCommandReply(ws, tid, bid, "pointFly", 0, "指点飞行命令已接收");
}

/**
 * 手动控制命令（offboard模式）
 * @param {number} data.x - 前进后退方向速度（米/秒），正值前进，负值后退
 * @param {number} data.y - 左右方向速度（米/秒），正值右移，负值左移
 * @param {number} data.h - 上下方向速度（米/秒），正值上升，负值下降
 * @param {number} data.w - 偏航角度增量（弧度），正值顺时针，负值逆时针，范围 -π ~ π
 * @param {number} data.r - 偏航角速度（弧度/秒），优先级高于w，正值顺时针，负值逆时针，范围 -3.0 ~ 3.0
 */
function handleDroneControl(ws, tid, bid, data) {
  const { x = 0, y = 0, h = 0, w, r } = data || {};
  console.log(`手动控制: x=${x}, y=${y}, h=${h}, w=${w}rad, r=${r}rad/s`);

  // 更新速度
  droneState.groundSpeed = Math.sqrt(Math.pow(x, 2) + Math.pow(y, 2));
  droneState.verticalSpeed = h;
  droneState.totalSpeed = Math.sqrt(
    Math.pow(x, 2) + Math.pow(y, 2) + Math.pow(h, 2),
  );

  // 更新偏航角（优先使用角速度r，否则使用角度增量w）
  if (r !== undefined && r !== null) {
    // r优先级更高：角速度(rad/s)，假设3Hz更新频率
    const yawChangeRad = r * 0.333; // 转换为角度增量
    setDroneHeading(droneState.heading + (yawChangeRad * 180) / Math.PI);
  } else if (w !== undefined && w !== null) {
    // w：角度增量(rad)，直接转换为角度
    setDroneHeading(droneState.heading + (w * 180) / Math.PI);
  } else {
    setDroneHeading(droneState.heading);
  }

  sendCommandReply(ws, tid, bid, "droneControl", 0, "手动控制命令已接收");
}

/**
 * 设置飞行模式命令
 */
function handleAirplaneMode(ws, tid, bid, data) {
  const { modeCode } = data || {};
  const modeNames = {
    1: "offboard模式",
    2: "定点模式",
    3: "自动任务模式",
    4: "自动返航模式",
    5: "定高模式",
    6: "手动模式",
    7: "悬停模式",
    8: "自动降落模式",
    9: "自动起飞模式",
    10: "自稳模式",
    11: "特技模式",
    12: "Rattitude模式",
  };

  droneState.mode = modeNames[modeCode] || "未知模式";

  console.log(`飞行模式切换为: ${droneState.mode}`);
  sendCommandReply(
    ws,
    tid,
    bid,
    "airplaneMode",
    0,
    `飞行模式已切换为${droneState.mode}`,
  );
}

/**
 * 航线飞行命令
 */
function handleRouteFly(ws, tid, bid, data) {
  const { plan } = data || {};
  if (!plan || typeof plan !== "string") {
    sendCommandReply(ws, tid, bid, "routeFly", -1, "航线文件路径不能为空");
    return;
  }
  console.log(`航线飞行: ${plan}`);

  droneState.mode = "自动任务模式";
  droneState.currentWaypointSeq = 1;

  sendCommandReply(ws, tid, bid, "routeFly", 0, "航线飞行命令已接收");
}

/**
 * 断点续飞命令
 */
function handleContinueFly(ws, tid, bid) {
  console.log("断点续飞");
  droneState.mode = "自动任务模式";
  sendCommandReply(ws, tid, bid, "continueFly", 0, "断点续飞命令已接收");
}

/**
 * 航点跳转命令
 */
function handleWaypointJump(ws, tid, bid, data) {
  const { targetSeq } = data || {};
  if (!Number.isInteger(targetSeq) || targetSeq < 1) {
    sendCommandReply(
      ws,
      tid,
      bid,
      "waypointJump",
      -1,
      "航点号必须为大于 0 的整数",
    );
    return;
  }
  console.log(`航点跳转到: ${targetSeq}`);
  droneState.currentWaypointSeq = targetSeq;
  sendCommandReply(ws, tid, bid, "waypointJump", 0, `已跳转到航点${targetSeq}`);
}

/**
 * 智能飞行命令
 */
function handleSmartFlight(ws, tid, bid, data) {
  const { enabled } = data || {};
  console.log(`智能飞行: ${enabled ? "进入" : "退出"}`);

  droneState.obstacleAvoidance = enabled === 1;
  droneState.terrainFollowing = enabled === 1;
  droneState.visionLanding = enabled === 1;

  sendCommandReply(
    ws,
    tid,
    bid,
    "smartFlight",
    0,
    enabled ? "已进入智能飞行模式" : "已退出智能飞行模式",
  );
}

/**
 * 设置低电量报警阈值。
 */
function handleSetCustomBatteryAlarm(ws, tid, bid, data = {}) {
  const { criticallyLowBattery, lowBattery } = data;
  if (Number.isFinite(criticallyLowBattery)) {
    droneState.criticallyLowBattery = criticallyLowBattery;
  }
  if (Number.isFinite(lowBattery)) {
    droneState.lowBattery = lowBattery;
  }
  sendCommandReply(
    ws,
    tid,
    bid,
    "setCustomBatteryAlarm",
    0,
    "电量报警阈值已设置",
  );
}

/**
 * 设置起飞前飞行限制参数。
 */
function handleSetFlightLimits(ws, tid, bid, data = {}) {
  const limitKeys = [
    "returnFlightAltitude",
    "heightEnabled",
    "heightLimit",
    "distanceEnabled",
    "distanceLimit",
    "takeoffAltitude",
    "takeoffSpeed",
  ];
  for (const key of limitKeys) {
    if (data[key] !== undefined) {
      droneState.flightLimits[key] = data[key];
    }
  }
  sendCommandReply(ws, tid, bid, "setFlightLimits", 0, "飞行限制参数已设置");
}

/**
 * 设置避障开关和刹停策略。
 */
function handleObstacleAvoidance(ws, tid, bid, data = {}) {
  if (data.enabled !== undefined) {
    droneState.obstacleAvoidance = data.enabled === 1 || data.enabled === true;
  }
  if ([1, 2, 3].includes(data.stop)) {
    droneState.obstacleStopStrategy = data.stop;
  }
  sendCommandReply(ws, tid, bid, "obstacleAvoidance", 0, "避障设置已更新");
}

/**
 * 设置失联、返航点和摇杆模式。
 */
function handleSetAdvancedLimits(ws, tid, bid, data = {}) {
  const limitKeys = ["lossOfContact", "returnPointBehavior", "joystickMode"];
  for (const key of limitKeys) {
    if (data[key] !== undefined) {
      droneState.advancedLimits[key] = data[key];
    }
  }
  sendCommandReply(ws, tid, bid, "setAdvancedLimits", 0, "进阶控制参数已设置");
}

function handleTakePhoto(ws, tid, bid, data = {}) {
  const { camera } = data;
  if (!camera) {
    sendCommandReply(ws, tid, bid, "takePhoto", -1, "相机型号不能为空");
    return;
  }
  droneState.lastPhotoCamera = camera;
  sendCommandReply(ws, tid, bid, "takePhoto", 0, "拍照命令已接收");
}

function handleStartVideo(ws, tid, bid, data = {}) {
  const { camera } = data;
  if (!camera) {
    sendCommandReply(ws, tid, bid, "startVideo", -1, "相机型号不能为空");
    return;
  }
  droneState.recordingCameras.add(camera);
  droneState.recordingStartedAt ||= Date.now();
  sendCommandReply(ws, tid, bid, "startVideo", 0, "录像已开始");
}

function handleEndVideo(ws, tid, bid, data = {}) {
  const { camera } = data;
  if (!camera) {
    sendCommandReply(ws, tid, bid, "endVideo", -1, "相机型号不能为空");
    return;
  }
  droneState.recordingCameras.delete(camera);
  if (droneState.recordingCameras.size === 0) {
    droneState.recordingStartedAt = null;
  }
  sendCommandReply(ws, tid, bid, "endVideo", 0, "录像已结束");
}

function handleGimbalControl(ws, tid, bid, data = {}) {
  const { pitch, yaw, model } = data;
  if (Number.isFinite(pitch)) {
    droneState.gimbalPitch = Math.max(-180, Math.min(180, pitch));
  }
  if (Number.isFinite(yaw)) {
    droneState.gimbalYaw = Math.max(-180, Math.min(180, yaw));
  }
  if (model) {
    droneState.cameraControl.model = model;
  }
  sendCommandReply(ws, tid, bid, "gimbalControl", 0, "云台控制命令已接收");
}

function handleCameraControl(ws, tid, bid, data = {}) {
  const { sensorId, focusDir, laserAction, model } = data;
  if ([0, 1, 2, 3].includes(sensorId)) {
    droneState.cameraControl.sensorId = sensorId;
  }
  if ([-1, 0, 1].includes(focusDir)) {
    droneState.cameraControl.focusDir = focusDir;
  }
  if ([0, 1, 2, 3].includes(laserAction)) {
    droneState.cameraControl.laserAction = laserAction;
  }
  if (model) {
    droneState.cameraControl.model = model;
  }
  sendCommandReply(ws, tid, bid, "cameraControl", 0, "相机控制命令已接收");
}

function handleLedLight(ws, tid, bid, data = {}) {
  if (
    data.enabled !== 0 &&
    data.enabled !== 1 &&
    data.enabled !== false &&
    data.enabled !== true
  ) {
    sendCommandReply(ws, tid, bid, "ledLight", -1, "LED 开关必须为 0 或 1");
    return;
  }
  droneState.downLedEnabled = data.enabled === 1 || data.enabled === true;
  sendCommandReply(
    ws,
    tid,
    bid,
    "ledLight",
    0,
    `LED 灯已${droneState.downLedEnabled ? "开启" : "关闭"}`,
  );
}

/**
 * 开始发送遥测数据
 */
function startTelemetry() {
  console.log("开始发送遥测数据");
  startSimulatedLandingScenario();

  // 2Hz: 基础数据 + 飞行状态
  timer2Hz = setInterval(() => {
    const data = generate2HzData();
    broadcastToClients(data);
  }, CONFIG.FREQ_2HZ);

  // 1Hz: 电池、感知数据
  timer1Hz = setInterval(() => {
    const data = generate1HzData();
    broadcastToClients(data);
  }, CONFIG.FREQ_1HZ);
}

/**
 * 停止发送遥测数据
 */
function stopTelemetry() {
  console.log("停止发送遥测数据");
  stopSimulatedLandingScenario();
  if (timer2Hz) {
    clearInterval(timer2Hz);
    timer2Hz = null;
  }
  if (timer1Hz) {
    clearInterval(timer1Hz);
    timer1Hz = null;
  }
}

/**
 * 广播消息给所有已认证客户端
 */
function broadcastToClients(data) {
  authenticatedClients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && client.isAuthenticated) {
      client.send(JSON.stringify(data));
    }
  });
}

/**
 * 启动FTP服务
 */
function startFtpServer() {
  // 创建FTP根目录
  if (!fs.existsSync(CONFIG.FTP_ROOT)) {
    fs.mkdirSync(CONFIG.FTP_ROOT, { recursive: true });
    console.log("创建FTP根目录:", CONFIG.FTP_ROOT);
  }

  // 创建示例文件
  const planDir = path.join(CONFIG.FTP_ROOT, "plan", "app");
  if (!fs.existsSync(planDir)) {
    fs.mkdirSync(planDir, { recursive: true });
  }

  // WebDAV 媒体目录：日期目录直接位于 /ssd 下，不再使用 /media。
  const ssdDir = path.join(CONFIG.FTP_ROOT, "ssd");
  if (!fs.existsSync(ssdDir)) {
    fs.mkdirSync(ssdDir, { recursive: true });
  }

  // 创建示例航线文件
  const planFile = path.join(planDir, "20260410141629.plan");
  if (!fs.existsSync(planFile)) {
    const planData = {
      fileType: "Plan",
      version: 1,
      groundStation: "QGroundControl",
      geoFence: { version: 2, circles: [], polygons: [] },
      rallyPoints: { version: 2, points: [] },
      mission: {
        cruiseSpeed: 10.0,
        firmwareType: 12,
        globalPlanAltitudeMode: 50.0,
        hoverSpeed: 10.0,
        version: 2,
        vehicleType: 2,
        plannedHomePosition: [31.900297, 118.933955, 50.0],
        items: [
          {
            autoContinue: true,
            doJumpId: 1,
            command: 22,
            frame: 3,
            type: "SimpleItem",
            params: [0, 0, 0, 0, 0, 0, 50],
            altitude: 50,
          },
          {
            autoContinue: true,
            doJumpId: 2,
            command: 16,
            frame: 3,
            type: "SimpleItem",
            params: [0, 0, 0, null, 31.900297, 118.933955, 50],
            altitude: 50,
          },
          {
            autoContinue: true,
            doJumpId: 3,
            command: 16,
            frame: 3,
            type: "SimpleItem",
            params: [0, 0, 0, null, 31.90051, 118.934575, 50],
            altitude: 50,
          },
          {
            autoContinue: true,
            doJumpId: 4,
            command: 20,
            frame: 3,
            type: "SimpleItem",
            params: [null, null, null, null, null, null, null],
            altitude: 0,
          },
        ],
      },
    };
    fs.writeFileSync(planFile, JSON.stringify(planData, null, 2));
    console.log("创建示例航线文件:", planFile);
  }

  // 使用自定义FTP服务器
  const ftpServer = new SimpleFtpServer({
    port: CONFIG.FTP_PORT,
    root: CONFIG.FTP_ROOT,
    username: CONFIG.FTP_USERNAME,
    password: CONFIG.FTP_PASSWORD,
  });

  ftpServer.start();

  return ftpServer;
}

/**
 * 启动 WebDAV 服务
 */
function startWebDavServer() {
  const webDavServer = new SimpleWebDavServer({
    port: CONFIG.WEBDAV_PORT,
    root: CONFIG.FTP_ROOT,
    users: CONFIG.WEBDAV_USERS,
    allowedRoots: CONFIG.WEBDAV_ALLOWED_ROOTS,
  });

  webDavServer.start();
  return webDavServer;
}

// 优雅关闭
process.on("SIGINT", () => {
  console.log("服务端关闭");
  stopTelemetry();
  wss.close();
  if (ftpServer) {
    ftpServer.stop();
  }
  if (webDavServer) {
    webDavServer.stop();
  }
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("服务端关闭");
  stopTelemetry();
  wss.close();
  if (ftpServer) {
    ftpServer.stop();
  }
  if (webDavServer) {
    webDavServer.stop();
  }
  process.exit(0);
});
