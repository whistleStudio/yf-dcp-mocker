/**
 * 无人机地面站WebSocket测试客户端
 * 用于测试服务端功能
 */

const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

// 配置
const CONFIG = {
  WS_URL: 'ws://localhost:8081',
  SOURCE: 'WE0GD95PA1667168259400',
  USERNAME: 'rkws',
  PASSWORD: 'qwer!@#$',
  DRONE_SN: '1F00223233510B34373435'
};

console.log('无人机地面站测试客户端');
console.log('连接地址:', CONFIG.WS_URL);

const ws = new WebSocket(CONFIG.WS_URL);
let bid = uuidv4();
let stats = {
  total2Hz: 0,
  total1Hz: 0,
  totalSelfCheck: 0,
  startTime: Date.now()
};

ws.on('open', () => {
  console.log('连接成功');

  // 发送认证请求
  const authMessage = {
    action: 'auth',
    source: CONFIG.SOURCE,
    username: CONFIG.USERNAME,
    password: CONFIG.PASSWORD
  };

  console.log('发送认证请求:', JSON.stringify(authMessage));
  ws.send(JSON.stringify(authMessage));
});

ws.on('message', (data) => {
  try {
    const message = JSON.parse(data);

    // 处理认证响应
    if (message.action === 'auth' && message.result === 'success') {
      console.log('认证成功，开始接收遥测数据；发送证书验签请求...\n');
      sendVerifyRequest();
      return;
    }

    if (message.action === 'verify' && message.result === 'success') {
      console.log('验签成功，开始测试控制命令...\n');
      setTimeout(() => testCommands(), 500);
      return;
    }

    // 处理命令回复
    if (message.action === 'command_reply') {
      console.log(`\n[命令回复] ${message.method}: ${message.data?.message}`);
      return;
    }

    // 统计遥测数据
    if (message.action === 'telemetry') {
      // 2Hz数据: basic_data + flight_status
      if (message.basic_data && message.flight_status) {
        stats.total2Hz++;
        if (stats.total2Hz % 20 === 0) {
          console.log(`[2Hz] #${stats.total2Hz} | 经度: ${message.basic_data.lng?.toFixed(6)} | 纬度: ${message.basic_data.lat?.toFixed(6)} | 高度: ${message.basic_data.relative_height?.toFixed(1)}m | 速度: ${message.basic_data.ground_speed?.toFixed(1)}m/s`);
        }
      }
      // 1Hz数据: perception + battery_system
      else if (message.perception && message.battery_system) {
        stats.total1Hz++;
        if (stats.total1Hz % 10 === 0) {
          console.log(`[1Hz]  #${stats.total1Hz} | 电量1: ${message.battery_system.battery1?.soc}% | 电量2: ${message.battery_system.battery2?.soc}% | 避障: ${message.perception.obstacle_avoidance?.enabled}`);
        }
      }
      // 认证后的一次性自检数据
      else if (message.self_check) {
        stats.totalSelfCheck++;
        console.log(`[自检] #${stats.totalSelfCheck} | 状态: ${message.self_check.overall} | 动力: ${message.self_check.items.power_system} | 航电: ${message.self_check.items.avionics_system}`);
      }
    }
  } catch (error) {
    console.error('消息处理错误:', error);
  }
});

ws.on('error', (error) => {
  console.error('WebSocket错误:', error);
});

ws.on('close', () => {
  console.log('\n连接关闭');
  printStats();
});

/**
 * 打印统计信息
 */
function printStats() {
  const duration = (Date.now() - stats.startTime) / 1000;
  console.log('\n=== 统计信息 ===');
  console.log(`运行时间: ${duration.toFixed(1)}秒`);
  console.log(`2Hz数据: ${stats.total2Hz}条 (平均${(stats.total2Hz / duration).toFixed(1)}Hz)`);
  console.log(`1Hz数据: ${stats.total1Hz}条 (平均${(stats.total1Hz / duration).toFixed(1)}Hz)`);
  console.log(`自检数据: ${stats.totalSelfCheck}条`);
}

/**
 * 测试各种命令
 */
function testCommands() {
  console.log('--- 开始测试命令 ---\n');

  // 1. 解锁
  sendCommand('unlock', {});

  setTimeout(() => {
    // 2. 起飞
    sendCommand('takeOff', { height: 10 });
  }, 1000);

  setTimeout(() => {
    // 3. 设置飞行模式
    sendCommand('airplaneMode', { modeCode: 2 });
  }, 3000);

  setTimeout(() => {
    // 4. 点指飞行
    sendCommand('pointFly', {
      longitude: '118.88',
      latitude: '31.92',
      height: 15
    });
  }, 5000);

  setTimeout(() => {
    // 5. 手动控制
    sendCommand('droneControl', { x: 2, y: 0, h: 0.5, w: 1.5 });
  }, 7000);

  setTimeout(() => {
    // 6. 悬停
    sendCommand('stop', {});
  }, 9000);

  setTimeout(() => {
    // 7. 返航
    sendCommand('backHome', {});
  }, 11000);

  setTimeout(() => {
    // 8. 降落
    sendCommand('land', { landHeight: 0 });
  }, 13000);

  setTimeout(() => {
    // 9. 上锁
    sendCommand('lock', {});
  }, 15000);

  setTimeout(() => {
    // 10. 测试新增的飞行与载荷控制项
    sendCommand('obstacleAvoidance', { enabled: 1, stop: 2 });
  }, 17000);

  setTimeout(() => {
    sendCommand('setCustomBatteryAlarm', { criticallyLowBattery: 15, lowBattery: 20 });
  }, 19000);

  setTimeout(() => {
    sendCommand('ledLight', { enabled: 0 });
  }, 21000);

  setTimeout(() => {
    sendCommand('gimbalControl', { pitch: -45, yaw: 45, pitchRate: 20, yawRate: 20, flags: 16, model: 'SG-2100' });
  }, 23000);
}

function sendVerifyRequest() {
  const verifyMessage = {
    action: 'verify',
    source: CONFIG.SOURCE,
    cert: '-----BEGIN CERTIFICATE-----\nMIIDETCCAfmgAwIBAgIGAZ5IenzuMA0GCSqGSIb3DQEBCwUAMDUxFTATBgNVBAMM\n-----END CERTIFICATE-----'
  };
  console.log('发送验签请求');
  ws.send(JSON.stringify(verifyMessage));
}

/**
 * 发送命令
 */
function sendCommand(method, data) {
  const command = {
    action: 'command',
    source: CONFIG.SOURCE,
    sn: CONFIG.DRONE_SN,
    devicetype: 'app',
    tid: uuidv4(),
    bid: bid,
    method,
    timestamp: Date.now(),
    data
  };

  console.log(`[发送命令] ${method}`);
  ws.send(JSON.stringify(command));
}

// 监听Ctrl+C
process.on('SIGINT', () => {
  console.log('\n测试中断');
  printStats();
  ws.close();
  process.exit(0);
});
