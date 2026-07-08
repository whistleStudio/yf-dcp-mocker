/**
 * FTP客户端
 * 连接到FTP服务器并提供文件上传、下载、管理等功能
 */

const ftp = require('ftp')
const fs = require('fs')
const path = require('path')

interface FtpClientOptions {
  ip: string
  port: number
  user?: string
  password?: string
}

class FtpClient {
  private client: any
  private options: Required<FtpClientOptions>
  private connected = false

  constructor(options: FtpClientOptions) {
    this.options = {
      user: 'firefly',
      password: 'firefly',
      ...options
    }
    this.client = new ftp()
  }

  /**
   * 连接到FTP服务器
   */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.client.on('ready', () => {
        this.connected = true
        console.log('FTP连接成功')
        resolve()
      })

      this.client.on('error', (err: Error) => {
        console.error('FTP连接错误:', err)
        reject(err)
      })

      this.client.connect({
        host: this.options.ip,
        port: this.options.port,
        user: this.options.user,
        password: this.options.password
      })
    })
  }

  /**
   * 上传文件到FTP服务器
   * @param localPath 本地文件路径
   * @param remotePath 远程文件路径
   */
  uploadFile(localPath: string, remotePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!fs.existsSync(localPath)) {
        reject(new Error(`本地文件不存在: ${localPath}`))
        return
      }

      const localSize = fs.statSync(localPath).size
      console.log(`开始上传: ${localPath} -> ${remotePath} (${localSize} bytes)`)

      const uploadStream = fs.createReadStream(localPath)
      let uploadError: Error | null = null

      uploadStream.on('error', (err: Error) => {
        uploadError = err
        console.error('上传流错误:', err)
      })

      this.client.put(uploadStream, remotePath, false, (err: Error | null) => {
        if (err || uploadError) {
          const error = err || uploadError!
          console.error('上传失败:', error.message)

          console.log('尝试清理残缺文件...')
          this.client.delete(remotePath, (deleteErr: Error | null) => {
            if (deleteErr) {
              console.log('清理失败（文件可能不存在）:', deleteErr.message)
            } else {
              console.log('已清理残缺文件:', remotePath)
            }
            reject(error)
          })
        } else {
          this.client.size(remotePath, (sizeErr: Error | null, remoteSize: number) => {
            if (sizeErr) {
              console.log('上传成功（无法验证大小）:', remotePath)
              resolve(remotePath)
            } else if (remoteSize === localSize) {
              console.log(`上传成功 (${remoteSize} bytes):`, remotePath)
              resolve(remotePath)
            } else {
              console.error(`上传失败: 文件大小不匹配 (本地${localSize} vs 远程${remoteSize})`)
              this.client.delete(remotePath, () => {
                reject(new Error('文件大小验证失败'))
              })
            }
          })
        }
      })
    })
  }

  /**
   * 下载文件从FTP服务器
   * @param remotePath 远程文件路径
   * @param localPath 本地文件路径
   */
  downloadFile(remotePath: string, localPath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      console.log(`开始下载: ${remotePath} -> ${localPath}`)

      this.client.get(remotePath, false, (err: Error | null, stream: any) => {
        if (err) {
          console.error('下载失败:', err)
          reject(err)
          return
        }

        const dir = path.dirname(localPath)
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true })
        }

        const writeStream = fs.createWriteStream(localPath)
        stream.pipe(writeStream)

        writeStream.on('finish', () => {
          console.log('下载成功:', localPath)
          resolve(localPath)
        })

        writeStream.on('error', (err: Error) => {
          console.error('写入文件失败:', err)
          reject(err)
        })
      })
    })
  }

  /**
   * 列出远程目录内容
   * @param remotePath 远程目录路径
   */
  listDir(remotePath: string = '/'): Promise<any[]> {
    return new Promise((resolve, reject) => {
      this.client.list(remotePath, false, (err: Error | null, list: any[]) => {
        if (err) {
          console.error('列出目录失败:', err)
          reject(err)
        } else {
          console.log(`目录内容 (${remotePath}):`)
          list.forEach((item) => {
            const type = item.type === 'd' ? '[DIR]' : '[FILE]'
            const size = item.size ? `(${item.size} bytes)` : ''
            console.log(`  ${type} ${item.name} ${size}`)
          })
          resolve(list)
        }
      })
    })
  }

  /**
   * 创建远程目录
   * @param remotePath 远程目录路径
   */
  mkdir(remotePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.client.mkdir(remotePath, true, (err: Error | null) => {
        if (err) {
          console.error('创建目录失败:', err)
          reject(err)
        } else {
          console.log('创建目录成功:', remotePath)
          resolve(remotePath)
        }
      })
    })
  }

  /**
   * 删除远程文件
   * @param remotePath 远程文件路径
   */
  deleteFile(remotePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.client.delete(remotePath, (err: Error | null) => {
        if (err) {
          console.error('删除文件失败:', err)
          reject(err)
        } else {
          console.log('删除文件成功:', remotePath)
          resolve(remotePath)
        }
      })
    })
  }

  /**
   * 批量上传文件（原子性：全部成功或全部回滚）
   * @param files [{localPath, remotePath}, ...]
   */
  async uploadFiles(files: { localPath: string; remotePath: string }[]): Promise<string[]> {
    const uploaded: string[] = []

    try {
      for (const file of files) {
        const result = await this.uploadFile(file.localPath, file.remotePath)
        uploaded.push(result)
      }
      console.log(`✅ 批量上传成功: ${uploaded.length}个文件`)
      return uploaded
    } catch (err) {
      console.error('❌ 批量上传失败，开始回滚...')

      for (const remotePath of uploaded) {
        try {
          await this.deleteFile(remotePath)
          console.log('已回滚:', remotePath)
        } catch (deleteErr: any) {
          console.error('回滚失败:', remotePath, deleteErr.message)
        }
      }

      throw err
    }
  }

  /**
   * 检查远程文件是否存在
   * @param remotePath 远程文件路径
   */
  fileExists(remotePath: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.client.size(remotePath, (err: Error | null) => {
        resolve(!err)
      })
    })
  }

  /**
   * 获取远程文件大小
   * @param remotePath 远程文件路径
   */
  getFileSize(remotePath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      this.client.size(remotePath, (err: Error | null, size: number) => {
        if (err) reject(err)
        else resolve(size)
      })
    })
  }

  /**
   * 上传文件（可选：不覆盖已存在文件）
   * @param localPath 本地文件路径
   * @param remotePath 远程文件路径
   * @param options 选项 { overwrite: true/false }
   */
  async uploadFileEx(
    localPath: string,
    remotePath: string,
    options: { overwrite?: boolean } = {}
  ): Promise<string> {
    const { overwrite = true } = options

    if (!overwrite) {
      const exists = await this.fileExists(remotePath)
      if (exists) {
        console.log(`跳过（已存在）: ${remotePath}`)
        return remotePath
      }
    }

    return this.uploadFile(localPath, remotePath)
  }

  /**
   * 测试上传速度
   * @param sizeMB 测试文件大小(MB)
   */
  async testUploadSpeed(sizeMB: number = 1): Promise<{ time: number; speed: number }> {
    const testFile = path.join(__dirname, `speed-test-${sizeMB}MB.bin`)
    const remotePath = `/speed-test-${sizeMB}MB.bin`

    try {
      console.log(`生成 ${sizeMB}MB 测试文件...`)
      const bufferSize = 1024 * 1024
      const buffer = Buffer.alloc(bufferSize, 0x41)
      const writeStream = fs.createWriteStream(testFile)

      for (let i = 0; i < sizeMB; i++) {
        writeStream.write(buffer)
      }
      writeStream.end()

      await new Promise<void>((resolve) => writeStream.on('finish', resolve))

      const fileSize = fs.statSync(testFile).size
      console.log(`文件大小: ${(fileSize / 1024 / 1024).toFixed(2)} MB`)

      console.log('开始上传...')
      const uploadStart = Date.now()
      await this.uploadFile(testFile, remotePath)
      const uploadTime = Date.now() - uploadStart

      const speed = fileSize / 1024 / 1024 / (uploadTime / 1000)
      console.log(`\n=== 测试结果 ===`)
      console.log(`上传时间: ${uploadTime}ms`)
      console.log(`上传速度: ${speed.toFixed(2)} MB/s`)

      await this.deleteFile(remotePath)
      fs.unlinkSync(testFile)

      return { time: uploadTime, speed }
    } catch (err) {
      if (fs.existsSync(testFile)) fs.unlinkSync(testFile)
      throw err
    }
  }

  /**
   * 断开FTP连接
   */
  disconnect(): Promise<void> {
    return new Promise((resolve) => {
      this.client.end()
      this.connected = false
      console.log('FTP连接已断开')
      resolve()
    })
  }

  /**
   * 是否已连接
   */
  isConnected(): boolean {
    return this.connected
  }
}

export default FtpClient
