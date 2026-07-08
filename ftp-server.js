/**
 * 简易FTP服务器
 * 用于无人机航线文件传输
 */

const net = require('net');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

class SimpleFtpServer {
  constructor(options = {}) {
    this.port = options.port || 21;
    this.root = options.root || path.join(__dirname, 'ftp-data');
    this.username = options.username || 'firefly';
    this.password = options.password || 'firefly';
    this.server = null;
    this.clients = new Map();
  }

  start() {
    // 确保根目录存在
    if (!fs.existsSync(this.root)) {
      fs.mkdirSync(this.root, { recursive: true });
    }

    this.server = net.createServer((socket) => {
      const client = {
        id: uuidv4(),
        socket,
        cwd: '/',
        authenticated: false,
        dataSocket: null,
        mode: null // 'passive' or 'active'
      };

      this.clients.set(client.id, client);
      console.log(`[FTP] 新客户端连接: ${client.id}`);

      socket.write('220 Welcome to Drone FTP Server\r\n');

      socket.on('data', (data) => {
        this.handleCommand(client, data.toString().trim());
      });

      socket.on('close', () => {
        console.log(`[FTP] 客户端断开: ${client.id}`);
        this.clients.delete(client.id);
      });

      socket.on('error', (err) => {
        console.error(`[FTP] 客户端错误: ${client.id}`, err.message);
      });
    });

    this.server.listen(this.port, () => {
      console.log(`[FTP] 服务器启动成功，端口: ${this.port}`);
      console.log(`[FTP] 根目录: ${this.root}`);
    });

    return this.server;
  }

  handleCommand(client, command) {
    const parts = command.split(' ');
    const cmd = parts[0].toUpperCase();
    const args = parts.slice(1);

    console.log(`[FTP] ${client.id}: ${command}`);

    switch (cmd) {
      case 'USER':
        this.handleUser(client, args[0]);
        break;
      case 'PASS':
        this.handlePass(client, args[0]);
        break;
      case 'PWD':
        this.handlePwd(client);
        break;
      case 'CWD':
        this.handleCwd(client, args[0]);
        break;
      case 'LIST':
        this.handleList(client, args[0]);
        break;
      case 'PASV':
        this.handlePasv(client);
        break;
      case 'STOR':
        this.handleStor(client, args[0]);
        break;
      case 'RETR':
        this.handleRetr(client, args[0]);
        break;
      case 'DELE':
        this.handleDele(client, args[0]);
        break;
      case 'MKD':
        this.handleMkd(client, args[0]);
        break;
      case 'RMD':
        this.handleRmd(client, args[0]);
        break;
      case 'SIZE':
        this.handleSize(client, args[0]);
        break;
      case 'QUIT':
        this.handleQuit(client);
        break;
      case 'TYPE':
        client.socket.write('200 Type set\r\n');
        break;
      case 'FEAT':
        client.socket.write('211-Features:\r\n SIZE\r\n UTF8\r\n211 End\r\n');
        break;
      case 'OPTS':
        client.socket.write('200 Options set\r\n');
        break;
      default:
        client.socket.write(`502 Command not implemented: ${cmd}\r\n`);
    }
  }

  handleUser(client, username) {
    if (username === this.username) {
      client.socket.write('331 Password required\r\n');
    } else {
      client.socket.write('530 Invalid username\r\n');
    }
  }

  handlePass(client, password) {
    if (password === this.password) {
      client.authenticated = true;
      client.socket.write('230 Login successful\r\n');
      console.log(`[FTP] 用户登录成功: ${client.id}`);
    } else {
      client.socket.write('530 Invalid password\r\n');
    }
  }

  handlePwd(client) {
    client.socket.write(`257 "${client.cwd}" is current directory\r\n`);
  }

  handleCwd(client, dir) {
    if (!dir) {
      client.socket.write('550 Invalid directory\r\n');
      return;
    }

    let newPath;
    if (dir === '/') {
      newPath = '/';
    } else if (dir === '..') {
      const parts = client.cwd.split('/').filter(Boolean);
      parts.pop();
      newPath = '/' + parts.join('/');
    } else if (dir.startsWith('/')) {
      newPath = dir;
    } else {
      newPath = client.cwd === '/' ? `/${dir}` : `${client.cwd}/${dir}`;
    }

    // 验证路径存在
    const fullPath = path.join(this.root, newPath);
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
      client.cwd = newPath;
      client.socket.write('250 Directory changed\r\n');
    } else {
      client.socket.write('550 Directory not found\r\n');
    }
  }

  handlePasv(client) {
    // 创建被动模式数据服务器
    const dataServer = net.createServer((dataSocket) => {
      client.dataSocket = dataSocket;
      console.log(`[FTP] 数据连接建立: ${client.id}`);
    });

    dataServer.listen(0, '127.0.0.1', () => {
      const port = dataServer.address().port;
      const ip = '127,0,0,1';
      client.socket.write(`227 Entering Passive Mode (${ip},${Math.floor(port / 256)},${port % 256})\r\n`);
      client.mode = 'passive';
      client.dataServer = dataServer;
    });

    dataServer.on('error', (err) => {
      console.error('[FTP] 数据服务器错误:', err);
      client.socket.write('425 Can\'t open data connection\r\n');
    });
  }

  handleList(client, targetPath) {
    if (!client.authenticated) {
      client.socket.write('530 Not logged in\r\n');
      return;
    }

    if (!client.dataSocket) {
      client.socket.write('425 Use PASV first\r\n');
      return;
    }

    let dirPath = targetPath || client.cwd;
    if (!dirPath.startsWith('/')) {
      dirPath = client.cwd === '/' ? `/${dirPath}` : `${client.cwd}/${dirPath}`;
    }

    const fullPath = path.join(this.root, dirPath);

    fs.readdir(fullPath, { withFileTypes: true }, (err, files) => {
      if (err) {
        client.socket.write('550 Directory not found\r\n');
        this.closeDataConnection(client);
        return;
      }

      client.socket.write('150 Opening data connection\r\n');

      // 生成目录列表
      let listing = '';
      files.forEach(file => {
        const isDir = file.isDirectory();
        const stat = fs.statSync(path.join(fullPath, file.name));
        const size = isDir ? 0 : stat.size;
        const date = stat.mtime;
        const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

        // 格式: drwxr-xr-x 1 owner group 1234 Jan 01 00:00 dirname
        const perms = isDir ? 'drwxr-xr-x' : '-rw-r--r--';
        const line = `${perms} 1 owner group ${String(size).padStart(8)} ${monthNames[date.getMonth()]} ${String(date.getDate()).padStart(2)} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')} ${file.name}\r\n`;
        listing += line;
      });

      client.dataSocket.write(listing);
      client.dataSocket.end();

      client.socket.write('226 Transfer complete\r\n');
      this.closeDataConnection(client);
    });
  }

  handleStor(client, filename) {
    if (!client.authenticated) {
      client.socket.write('530 Not logged in\r\n');
      return;
    }

    if (!client.dataSocket) {
      client.socket.write('425 Use PASV first\r\n');
      return;
    }

    if (!filename) {
      client.socket.write('550 Invalid filename\r\n');
      return;
    }

    // 计算完整路径
    let remotePath = filename;
    if (!remotePath.startsWith('/')) {
      remotePath = client.cwd === '/' ? `/${remotePath}` : `${client.cwd}/${remotePath}`;
    }

    const fullPath = path.join(this.root, remotePath);

    // 确保目录存在
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    client.socket.write('150 Opening data connection\r\n');

    const writeStream = fs.createWriteStream(fullPath);
    let totalBytes = 0;

    client.dataSocket.on('data', (chunk) => {
      totalBytes += chunk.length;
    });

    client.dataSocket.pipe(writeStream);

    writeStream.on('finish', () => {
      console.log(`[FTP] 文件上传完成: ${remotePath} (${totalBytes} bytes)`);
      client.socket.write('226 Transfer complete\r\n');
      this.closeDataConnection(client);
    });

    writeStream.on('error', (err) => {
      console.error('[FTP] 写入错误:', err);
      client.socket.write('451 Requested action aborted\r\n');
      this.closeDataConnection(client);
    });
  }

  handleRetr(client, filename) {
    if (!client.authenticated) {
      client.socket.write('530 Not logged in\r\n');
      return;
    }

    if (!client.dataSocket) {
      client.socket.write('425 Use PASV first\r\n');
      return;
    }

    if (!filename) {
      client.socket.write('550 Invalid filename\r\n');
      return;
    }

    let remotePath = filename;
    if (!remotePath.startsWith('/')) {
      remotePath = client.cwd === '/' ? `/${remotePath}` : `${client.cwd}/${remotePath}`;
    }

    const fullPath = path.join(this.root, remotePath);

    if (!fs.existsSync(fullPath)) {
      client.socket.write('550 File not found\r\n');
      this.closeDataConnection(client);
      return;
    }

    client.socket.write('150 Opening data connection\r\n');

    const readStream = fs.createReadStream(fullPath);
    readStream.pipe(client.dataSocket);

    readStream.on('end', () => {
      client.socket.write('226 Transfer complete\r\n');
      this.closeDataConnection(client);
    });

    readStream.on('error', (err) => {
      console.error('[FTP] 读取错误:', err);
      client.socket.write('451 Requested action aborted\r\n');
      this.closeDataConnection(client);
    });
  }

  handleDele(client, filename) {
    if (!client.authenticated) {
      client.socket.write('530 Not logged in\r\n');
      return;
    }

    if (!filename) {
      client.socket.write('550 Invalid filename\r\n');
      return;
    }

    let remotePath = filename;
    if (!remotePath.startsWith('/')) {
      remotePath = client.cwd === '/' ? `/${remotePath}` : `${client.cwd}/${remotePath}`;
    }

    const fullPath = path.join(this.root, remotePath);

    fs.unlink(fullPath, (err) => {
      if (err) {
        client.socket.write('550 File not found\r\n');
      } else {
        console.log(`[FTP] 文件删除: ${remotePath}`);
        client.socket.write('250 File deleted\r\n');
      }
    });
  }

  handleMkd(client, dirname) {
    if (!client.authenticated) {
      client.socket.write('530 Not logged in\r\n');
      return;
    }

    if (!dirname) {
      client.socket.write('550 Invalid directory name\r\n');
      return;
    }

    let remotePath = dirname;
    if (!remotePath.startsWith('/')) {
      remotePath = client.cwd === '/' ? `/${remotePath}` : `${client.cwd}/${remotePath}`;
    }

    const fullPath = path.join(this.root, remotePath);

    fs.mkdir(fullPath, { recursive: true }, (err) => {
      if (err) {
        client.socket.write('550 Can\'t create directory\r\n');
      } else {
        console.log(`[FTP] 目录创建: ${remotePath}`);
        client.socket.write(`257 "${dirname}" created\r\n`);
      }
    });
  }

  handleRmd(client, dirname) {
    if (!client.authenticated) {
      client.socket.write('530 Not logged in\r\n');
      return;
    }

    if (!dirname) {
      client.socket.write('550 Invalid directory name\r\n');
      return;
    }

    let remotePath = dirname;
    if (!remotePath.startsWith('/')) {
      remotePath = client.cwd === '/' ? `/${remotePath}` : `${client.cwd}/${remotePath}`;
    }

    const fullPath = path.join(this.root, remotePath);

    fs.rmdir(fullPath, (err) => {
      if (err) {
        client.socket.write('550 Can\'t remove directory\r\n');
      } else {
        console.log(`[FTP] 目录删除: ${remotePath}`);
        client.socket.write('250 Directory removed\r\n');
      }
    });
  }

  handleSize(client, filename) {
    if (!filename) {
      client.socket.write('550 Invalid filename\r\n');
      return;
    }

    let remotePath = filename;
    if (!remotePath.startsWith('/')) {
      remotePath = client.cwd === '/' ? `/${remotePath}` : `${client.cwd}/${remotePath}`;
    }

    const fullPath = path.join(this.root, remotePath);

    fs.stat(fullPath, (err, stat) => {
      if (err) {
        client.socket.write('550 File not found\r\n');
      } else {
        client.socket.write(`213 ${stat.size}\r\n`);
      }
    });
  }

  handleQuit(client) {
    client.socket.write('221 Goodbye\r\n');
    this.closeDataConnection(client);
    client.socket.end();
  }

  closeDataConnection(client) {
    if (client.dataSocket) {
      client.dataSocket.destroy();
      client.dataSocket = null;
    }
    if (client.dataServer) {
      client.dataServer.close();
      client.dataServer = null;
    }
  }

  stop() {
    if (this.server) {
      this.server.close();
    }
    this.clients.forEach((client) => {
      this.closeDataConnection(client);
      client.socket.end();
    });
    this.clients.clear();
  }
}

module.exports = SimpleFtpServer;
