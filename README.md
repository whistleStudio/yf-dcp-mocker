# 无人机地面站WebSocket服务端

根据底软对接文档实现的Node.js WebSocket服务端，支持所有文档中定义的命令和遥测数据。

## 功能特性

### 消息格式

所有消息使用统一的JSON格式：

- **command**: 地面站→无人机（控制命令）
- **command_reply**: 无人机→地面站（命令回复）
- **telemetry**: 无人机→地面站（遥测数据）

### 认证机制
- **auth**: 用户名/密码认证
- **verify**: 证书验签

### 控制命令
- **unlock**: 解锁
- **lock**: 上锁
- **takeOff**: 起飞（可设置目标高度）
- **backHome**: 返航
- **land**: 降落（可设置降落高度）
- **stop**: 悬停
- **pointFly**: 点指飞行（可设置经纬度和高度）
- **droneControl**: 手动控制（X/Y/H/W方向控制）
- **airplaneMode**: 设置飞行模式
- **routeFly**: 航线飞行
- **continueFly**: 断点续飞
- **waypointJump**: 航点跳转
- **smartFlight**: 智能飞行进入/退出

### 遥测数据
认证成功后自动发送新版本遥测数据，包含：
- **basic_data**: 基础位姿数据
- **perception**: 感知数据（避障、仿地、视觉降落等）
- **position_attitude**: 位姿信息
- **communication**: 通讯信息（图传、5G）
- **avionics**: 航电系统信息
- **battery_system**: 电池系统信息
- **power_modules**: 电源模块状态
- **network_status**: 网络状态
- **hall_sensors**: 霍尔传感器状态
- **flight_status**: 飞行状态

其中 `basic_data` 的角度字段范围如下：`heading` 为 0-360 度（360 度与 0 度等价，实际输出为 `[0, 360)`），`yaw`、`pitch`、`roll` 均为 -180 到 180 度。

## 安装

```bash
npm install
```

## 启动服务端

```bash
# 开发模式（自动重启）
npm run dev

# 生产模式
npm start
```

服务端默认监听端口：`8081`

### 本地 WebDAV 文件服务

启动服务后，同时提供 WebDAV 文件服务：

- 地址：`http://localhost:1900/`
- 文件根目录：`ftp-data`（与 FTP 服务共用）
- `admin` / `admin123`：读写权限
- `viewer` / `viewer123`：读写权限

可在 Windows 文件资源管理器、RaiDrive、Cyberduck 等支持 WebDAV 的客户端中添加上述地址。也可使用 curl 验证：

```bash
curl -u admin:admin123 -X PROPFIND -H "Depth: 1" http://localhost:1900/
```

## 测试

### 使用测试客户端

```bash
node test-client.js
```

测试客户端会自动：
1. 连接服务端
2. 发送认证请求
3. 测试所有控制命令
4. 接收并显示遥测数据

### 手动测试

使用任何WebSocket客户端工具（如 wscat、Postman等）连接：
```
ws://localhost:8081
```

#### 认证请求
```json
{
  "action": "auth",
  "source": "WE0GD95PA1667168259400",
  "username": "rkws",
  "password": "qwer!@#$"
}
```

#### 起飞命令
```json
{
  "action": "command",
  "source": "WE0GD95PA1667168259400",
  "sn": "1F00223233510B34373435",
  "tid": "403dfed3-19be-468e-bdcf-4cd54e6b35fe",
  "bid": "98344d54-572d-4660-9003-516e161ff557",
  "method": "takeOff",
  "timestamp": 1654070968655,
  "data": {
    "height": 10
  }
}
```

#### 命令回复格式
```json
{
  "action": "command_reply",
  "source": "WE0GD95PA1667168259400",
  "sn": "1F00223233510B34373435",
  "tid": "403dfed3-19be-468e-bdcf-4cd54e6b35fe",
  "bid": "98344d54-572d-4660-9003-516e161ff557",
  "method": "takeOff",
  "timestamp": 1654070968655,
  "data": {
    "result": 0,
    "message": "起飞命令已接收"
  }
}
```

#### 遥测数据格式
```json
{
  "action": "telemetry",
  "source": "WE0GD95PA1667168259400",
  "sn": "1F00223233510B34373435",
  "tid": "...",
  "bid": "...",
  "method": "realtimeData",
  "timestamp": 1654070968655,
  "basic_data": {
    "lat": 31.230416,
    "lng": 121.473701,
    "alt": 50,
    "relative_height": 0,
    "ground_speed": 0,
    "vertical_speed": 0,
    "total_speed": 0,
    "heading": 0,
    "yaw": 0,
    "pitch": 0,
    "roll": 0
  },
  "perception": { ... },
  "position_attitude": { ... },
  "communication": { ... },
  "avionics": { ... },
  "battery_system": { ... },
  "power_modules": { ... },
  "network_status": { ... },
  "hall_sensors": { ... },
  "flight_status": {
    "remaining_flight_time": 45,
    "landed_state": 1,
    "mode_num": 2,
    "lock": true,
    "serial_number": "1581F6M1234567",
    "firmware_version": "v01.02.03",
    "board_type": "K9飞控",
    "current_waypoint_seq": 0
  }
}
```

## 配置

在 `server.js` 中修改以下配置：

```javascript
const CONFIG = {
  WS_PORT: 8081,                    // WebSocket端口
  AUTH_USERNAME: 'rkws',            // 认证用户名
  AUTH_PASSWORD: 'qwer!@#$',        // 认证密码
  TELEMETRY_INTERVAL: 500,          // 遥测数据发送间隔(ms)
  DRONE_SN: '1F00223233510B34373435' // 无人机序列号
};
```

## 消息流程

```
地面站                          无人机(服务端)
  |                                |
  |--- auth 认证请求 ------------->|
  |<-- auth 认证回复 --------------|
  |                                |
  |--- verify 验签请求 ----------->|
  |<-- verify 验签回复 ------------|
  |                                |
  |<-- telemetry 遥测数据 ---------| (自动推送)
  |<-- telemetry 遥测数据 ---------|
  |                                |
  |--- command 命令 -------------->|
  |<-- command_reply 命令回复 -----|
  |                                |
```

## 注意事项

1. 服务端模拟了无人机的飞行状态，包括起飞、降落、移动等过程
2. 遥测数据会实时更新，反映当前无人机状态
3. 所有命令都会返回统一格式的命令回复消息
4. 支持多个客户端同时连接
5. 认证成功后会自动推送遥测数据

## 目录结构

```
dcpserver/
├── package.json          # 项目配置
├── server.js             # WebSocket服务端
├── webdav-server.js      # 本地 WebDAV 服务
├── test-client.js        # 测试客户端
└── README.md             # 说明文档
```

## 依赖

- ws: WebSocket库
- uuid: UUID生成库
