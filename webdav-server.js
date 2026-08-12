/**
 * 本地 WebDAV 服务：Basic 认证、浏览、上传、下载、目录与文件管理。
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");

const MIME_TYPES = {
  ".json": "application/json; charset=utf-8",
  ".plan": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".pdf": "application/pdf",
};

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

class SimpleWebDavServer {
  constructor(options = {}) {
    this.port = options.port || 1900;
    this.root = path.resolve(options.root || path.join(__dirname, "ftp-data"));
    this.users = options.users || {};
    this.server = null;
  }

  start() {
    fs.mkdirSync(this.root, { recursive: true });
    this.server = http.createServer((request, response) => {
      this.handleRequest(request, response).catch((error) => {
        console.error("[WebDAV] 请求处理失败:", error);
        if (!response.headersSent) {
          this.sendStatus(response, error.statusCode || 500, error.message || "Internal Server Error");
        } else {
          response.destroy(error);
        }
      });
    });
    this.server.on("error", (error) => console.error("[WebDAV] 服务器错误:", error.message));
    this.server.listen(this.port, () => {
      console.log(`[WebDAV] 服务器启动成功，地址: http://localhost:${this.port}/`);
      console.log(`[WebDAV] 根目录: ${this.root}`);
    });
    return this.server;
  }

  stop() {
    if (this.server) this.server.close();
  }

  sendStatus(response, statusCode, body = "", headers = {}) {
    response.writeHead(statusCode, headers);
    response.end(body);
  }

  authenticate(request, response) {
    const match = /^Basic\s+(.+)$/i.exec(request.headers.authorization || "");
    if (!match) return this.sendAuthRequired(response);
    let credentials = "";
    try {
      credentials = Buffer.from(match[1], "base64").toString("utf8");
    } catch {
      // 保持空凭据，由后续校验拒绝。
    }
    const separator = credentials.indexOf(":");
    const username = separator >= 0 ? credentials.slice(0, separator) : "";
    const password = separator >= 0 ? credentials.slice(separator + 1) : "";
    const user = this.users[username];
    if (!user || user.password !== password) return this.sendAuthRequired(response);
    return { username, ...user };
  }

  sendAuthRequired(response) {
    this.sendStatus(response, 401, "Authentication required", {
      "WWW-Authenticate": 'Basic realm="Drone WebDAV", charset="UTF-8"',
    });
    return null;
  }

  getPathname(request) {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    } catch {
      const error = new Error("Invalid URL path");
      error.statusCode = 400;
      throw error;
    }
    if (pathname.includes("\0")) {
      const error = new Error("Invalid URL path");
      error.statusCode = 400;
      throw error;
    }
    return pathname.replace(/\\/g, "/");
  }

  resolvePath(pathname) {
    const filePath = path.resolve(this.root, pathname.replace(/^\/+/, ""));
    const relation = path.relative(this.root, filePath);
    if (relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
      const error = new Error("Path outside WebDAV root");
      error.statusCode = 403;
      throw error;
    }
    return filePath;
  }

  requireWritable(user, response) {
    if (!user.readOnly) return true;
    this.sendStatus(response, 403, "This account has read-only access");
    return false;
  }

  async handleRequest(request, response) {
    const user = this.authenticate(request, response);
    if (!user) return;
    const method = request.method.toUpperCase();
    const pathname = this.getPathname(request);
    const filePath = this.resolvePath(pathname);
    console.log(`[WebDAV] ${user.username} ${method} ${pathname}`);

    if (method === "OPTIONS") return this.handleOptions(response);
    if (method === "PROPFIND") return this.handlePropfind(request, response, pathname, filePath);
    if (method === "GET" || method === "HEAD") return this.handleGet(response, filePath, method === "HEAD");
    if (method === "PUT") return this.requireWritable(user, response) && this.handlePut(request, response, filePath);
    if (method === "MKCOL") return this.requireWritable(user, response) && this.handleMkcol(response, filePath);
    if (method === "DELETE") return this.requireWritable(user, response) && this.handleDelete(response, filePath);
    if (method === "MOVE" || method === "COPY") {
      return this.requireWritable(user, response) && this.handleMoveOrCopy(request, response, filePath, method);
    }
    return this.sendStatus(response, 405, "Method Not Allowed", { Allow: "OPTIONS, PROPFIND, GET, HEAD, PUT, MKCOL, DELETE, MOVE, COPY" });
  }

  handleOptions(response) {
    this.sendStatus(response, 200, "", {
      Allow: "OPTIONS, PROPFIND, GET, HEAD, PUT, MKCOL, DELETE, MOVE, COPY",
      DAV: "1",
      "MS-Author-Via": "DAV",
    });
  }

  async handleGet(response, filePath, headOnly) {
    let stat;
    try {
      stat = await fs.promises.stat(filePath);
    } catch (error) {
      return this.sendStatus(response, error.code === "ENOENT" ? 404 : 403, "File not found");
    }
    if (stat.isDirectory()) return this.sendStatus(response, 403, "Cannot download a directory");
    response.writeHead(200, {
      "Content-Length": stat.size,
      "Content-Type": MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Last-Modified": stat.mtime.toUTCString(),
    });
    if (headOnly) return response.end();
    fs.createReadStream(filePath).on("error", (error) => response.destroy(error)).pipe(response);
  }

  propResponse(href, stat) {
    const isDirectory = stat.isDirectory();
    const resourceHref = isDirectory && !href.endsWith("/") ? `${href}/` : href;
    const displayName = path.posix.basename(resourceHref.replace(/\/$/, "")) || "/";
    return `  <d:response>\r\n    <d:href>${escapeXml(resourceHref)}</d:href>\r\n    <d:propstat>\r\n      <d:prop>\r\n        <d:resourcetype>${isDirectory ? "<d:collection/>" : ""}</d:resourcetype>\r\n        <d:getcontentlength>${isDirectory ? 0 : stat.size}</d:getcontentlength>\r\n        <d:getlastmodified>${stat.mtime.toUTCString()}</d:getlastmodified>\r\n        <d:creationdate>${stat.birthtime.toISOString()}</d:creationdate>\r\n        <d:displayname>${escapeXml(displayName)}</d:displayname>\r\n      </d:prop>\r\n      <d:status>HTTP/1.1 200 OK</d:status>\r\n    </d:propstat>\r\n  </d:response>`;
  }

  async handlePropfind(request, response, pathname, filePath) {
    let stat;
    try {
      stat = await fs.promises.stat(filePath);
    } catch (error) {
      return this.sendStatus(response, error.code === "ENOENT" ? 404 : 403, "Resource not found");
    }
    const responses = [this.propResponse(pathname, stat)];
    if (stat.isDirectory() && (request.headers.depth || "infinity").toLowerCase() !== "0") {
      const children = await fs.promises.readdir(filePath, { withFileTypes: true });
      for (const child of children) {
        const childStat = await fs.promises.stat(path.join(filePath, child.name));
        const prefix = pathname.endsWith("/") ? pathname : `${pathname}/`;
        responses.push(this.propResponse(`${prefix}${encodeURIComponent(child.name)}`, childStat));
      }
    }
    const body = `<?xml version="1.0" encoding="utf-8"?>\r\n<d:multistatus xmlns:d="DAV:">\r\n${responses.join("\r\n")}\r\n</d:multistatus>`;
    this.sendStatus(response, 207, body, { "Content-Type": "application/xml; charset=utf-8" });
  }

  async handlePut(request, response, filePath) {
    let existed = true;
    try {
      if ((await fs.promises.stat(filePath)).isDirectory()) return this.sendStatus(response, 409, "Cannot overwrite a directory");
    } catch (error) {
      if (error.code !== "ENOENT") return this.sendStatus(response, 403, "Cannot write this resource");
      existed = false;
    }
    try {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await pipeline(request, fs.createWriteStream(filePath));
      this.sendStatus(response, existed ? 204 : 201);
    } catch (error) {
      console.error("[WebDAV] 上传失败:", error.message);
      this.sendStatus(response, 500, "Upload failed");
    }
  }

  async handleMkcol(response, filePath) {
    try {
      await fs.promises.mkdir(filePath);
      this.sendStatus(response, 201);
    } catch (error) {
      this.sendStatus(response, error.code === "EEXIST" ? 405 : error.code === "ENOENT" ? 409 : 403, "Unable to create collection");
    }
  }

  async handleDelete(response, filePath) {
    try {
      await fs.promises.rm(filePath, { recursive: true, force: false });
      this.sendStatus(response, 204);
    } catch (error) {
      this.sendStatus(response, error.code === "ENOENT" ? 404 : 403, "Unable to delete resource");
    }
  }

  async handleMoveOrCopy(request, response, sourcePath, method) {
    if (!request.headers.destination) return this.sendStatus(response, 400, "Destination header is required");
    let targetPath;
    try {
      targetPath = this.resolvePath(decodeURIComponent(new URL(request.headers.destination, "http://localhost").pathname));
    } catch {
      return this.sendStatus(response, 400, "Invalid destination");
    }
    if (sourcePath === targetPath) return this.sendStatus(response, 403, "Source and destination are identical");
    let targetExists = true;
    try { await fs.promises.access(targetPath); } catch { targetExists = false; }
    if (targetExists && String(request.headers.overwrite || "T").toUpperCase() === "F") return this.sendStatus(response, 412, "Destination already exists");
    try {
      await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
      if (targetExists) await fs.promises.rm(targetPath, { recursive: true, force: true });
      if (method === "MOVE") await fs.promises.rename(sourcePath, targetPath);
      else await fs.promises.cp(sourcePath, targetPath, { recursive: true });
      this.sendStatus(response, targetExists ? 204 : 201);
    } catch (error) {
      this.sendStatus(response, error.code === "ENOENT" ? 404 : 409, "Unable to move or copy resource");
    }
  }
}

module.exports = SimpleWebDavServer;
