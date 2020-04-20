const net = require('net')
const EventEmitter = require('events')
const cmdCfg = require('./commandsConfig')

class CMPPSocket extends EventEmitter {
  constructor(config) {
    super()
    this.config = config
    this.sequenceHolder = 1
    this.headerLength = 12
    this.sequencePromiseMap = {}
    this.isReady = false
    this.heartbeatAttempts = 0
  }

  handleHeartbeat() {
    const _this = this
    if (this.isReady) {
      this.heartbeatAttempts++
      if (this.heartbeatAttempts > this.config.heartbeatMaxAttempts) {
        this.disconnect()
        this.emit('terminated')
      }
      this.send(cmdCfg.Commands.CMPP_ACTIVE_TEST).then(function () {
        _this.heartbeatAttempts = 0
      }).catch(function () { })
    }
    this.heartbeatHandle = setTimeout(function () {
      _this.handleHeartbeat()
    }, this.config.heartbeatInterval)
  }

  connect(port, host) {
    const _this = this
    return this.connectSocket(port, host).then(() => {
      _this.handleHeartbeat()
      _this.isReady = true
      _this.sequenceHolder = 1
    }).catch((err) => {
      console.error(err)
      _this.destroySocket()
    })
  }

  connectSocket(port, host) {
    const _this = this
    if (this.isReady)
        return Promise.resolve()
    if (this.socket)
        return Promise.resolve()
    const deferred = Promise.defer()
    this.socket = new net.Socket()
    this.socket.on('data', function (buffer) {
        _this.handleData(buffer)
    })
    this.socket.on('error', function (err) {
        _this.emit('error', err)
        deferred.reject(err)
        _this.destroySocket()
    })
    this.socket.on('connect', function () {
        deferred.resolve()
    })
    this.socket.connect(port, host)
    return deferred.promise
  }

  disconnect() {
    const _this = this
    this.isReady = false
    clearTimeout(this.heartbeatHandle)
    return this.send(cmdCfg.Commands.CMPP_TERMINATE).catch(function () { }).finally(function () {
      _this.destroySocket()
    })
  }

  destroySocket() {
    this.isReady = false
    if (this.socket) {
      this.socket.end()
      this.socket.destroy()
      this.socket = undefined
    }
  }

  handleData(buffer) {
    if (!this.bufferCache) {
      this.bufferCache = buffer
    }
    else {
      this.bufferCache = Buffer.concat([this.bufferCache, buffer])
    }
    const obj = { header: undefined, buffer: undefined }
    while (this.fetchData(obj)) {
      this.handleBuffer(obj.buffer, obj.header)
    }
  }

  fetchData(obj) {
    if (!obj)
      return false
    if (this.bufferCache.length < 12)
      return false
    obj.header = this.readHeader(this.bufferCache)
    if (this.bufferCache.length < obj.header.Total_Length)
      return false
    obj.buffer = this.bufferCache.slice(0, obj.header.Total_Length)
    this.bufferCache = this.bufferCache.slice(obj.header.Total_Length)
    return true
  }

  handleBuffer(buffer, header) {
    const _this = this
    const body = this.readBody(header.Command_Id, buffer.slice(this.headerLength))
    if (header.Command_Id === cmdCfg.Commands.CMPP_TERMINATE) {
        this.emit('terminated')
        clearTimeout(this.heartbeatHandle)
        this.isReady = false
        this.sendResponse(cmdCfg.Commands.CMPP_TERMINATE_RESP, header.Sequence_Id)
        Promise.delay(100).then(function () { _this.destroySocket() })
        return
    }
    if (header.Command_Id === cmdCfg.Commands.CMPP_DELIVER) {
        this.sendResponse(cmdCfg.Commands.CMPP_DELIVER_RESP, header.Sequence_Id, { Msg_Id: body.Msg_Id, Result: 0 })
        this.emit('deliver', { header: header, body: body })
        return
    }
    if (header.Command_Id === cmdCfg.Commands.CMPP_ACTIVE_TEST) {
        this.sendResponse(cmdCfg.Commands.CMPP_ACTIVE_TEST_RESP, header.Sequence_Id)
        return
    }
    if (this.isResponse(header.Command_Id)) {
        const promise = this.popPromise(header.Sequence_Id)
        if (!promise) {
            this.emit('error', new Error(cmdCfg.Commands[header.Command_Id] + ': resp has no promise handle it'))
            return
        }
        clearTimeout(promise._timeoutHandle)
        if (this.hasError(body)) {
            let result = 'result:' + (cmdCfg.Errors[body.Result] || body.Result)
            if (header.Command_Id === cmdCfg.Commands.CMPP_CONNECT_RESP)
                result = 'status:' + (cmdCfg.Status[body.Status] || body.Status)
            const msg = 'command:' + cmdCfg.Commands[header.Command_Id] + ' failed. result:' + result
            promise.reject(new Error(msg))
        }
        else {
            promise.resolve({ header: header, body: body })
        }
        return
    }
    this.emit('error', new Error(cmdCfg.Commands[header.Command_Id] + ': no handler found'))
    return
  }

  sendResponse(command, sequence, body) {
    const buf = this.getBuf({ Sequence_Id: sequence, Command_Id: command }, body)
    this.socket.write(buf)
  }

  pushPromise(sequence, deferred) {
    if (!this.sequencePromiseMap[sequence])
      this.sequencePromiseMap[sequence] = deferred
    else if (_.isArray(this.sequencePromiseMap[sequence]))
      this.sequencePromiseMap[sequence].push(deferred)
    else
      this.sequencePromiseMap[sequence] = [this.sequencePromiseMap[sequence], deferred]
  }

  popPromise(sequence) {
    if (!this.sequencePromiseMap[sequence])
        return
    if (_.isArray(this.sequencePromiseMap[sequence])) {
        const promise = this.sequencePromiseMap[sequence].shift()
        if (_.isEmpty(this.sequencePromiseMap[sequence]))
            delete this.sequencePromiseMap[sequence]
        return promise
    }
    const promise = this.sequencePromiseMap[sequence]
    delete this.sequencePromiseMap[sequence]
    return promise
  }

  send(command, body) {
    const _this = this
    if (body && body['Pk_number'] === 1) {
        this.sequenceHolder++
    }
    const sequence = this.sequenceHolder
    const buf = this.getBuf({ Sequence_Id: sequence, Command_Id: command }, body)
    this.socket.write(buf)
    const deferred = Promise.defer()
    this.pushPromise(sequence, deferred)
    let timeout = this.config.timeout
    if (command === cmdCfg.Commands.CMPP_ACTIVE_TEST)
        timeout = this.config.heartbeatTimeout
    deferred['_timeoutHandle'] = setTimeout(function () {
        if (command !== cmdCfg.Commands.CMPP_ACTIVE_TEST) {
            _this.emit('timeout')
        }
        const msg = 'command:' + cmdCfg.Commands[command] + ' timeout.'
        deferred.reject(new Error(msg))
    }, timeout)
    return deferred.promise
  }

  getBuf(header, body) {
    header.Total_Length = this.headerLength
    let headBuf, bodyBuf
    if (body) {
        bodyBuf = this.getBodyBuffer(header.Command_Id, body)
        header.Total_Length += bodyBuf.length
    }
    headBuf = this.getHeaderBuffer(header)
    if (bodyBuf)
        return Buffer.concat([headBuf, bodyBuf])
    else
        return headBuf
  }

  hasError(body) {
    return body.Status !== void 0 && body.Status > 0 || body.Result !== void 0 && body.Result > 0
  }

  isResponse(Command_Id) {
    return Command_Id > 0x80000000
  }

  readHeader(buffer) {
    const obj = {}
    obj.Total_Length = buffer.readUInt32BE(0)
    obj.Command_Id = buffer.readUInt32BE(4)
    obj.Sequence_Id = buffer.readUInt32BE(8)
    return obj
  }

  getHeaderBuffer(header) {
    const buffer = new Buffer(this.headerLength)
    buffer.writeUInt32BE(header.Total_Length, 0)
    buffer.writeUInt32BE(header.Command_Id, 4)
    buffer.writeUInt32BE(header.Sequence_Id, 8)
    return buffer
  }

  readBody(command, buffer) {
    const _this = this
    const obj = {}
    let commandStr
    if (_.isNumber(command))
        commandStr = cmdCfg.Commands[command]
    else
        commandStr = command
    const commandDesp = cmdCfg.CommandsDescription[commandStr]
    if (!commandDesp)
        return obj
    commandDesp.forEach(function (field) {
        obj[field.name] = _this.getValue(buffer, field, obj)
    })

    if (command === cmdCfg.Commands.CMPP_DELIVER) {
        if (obj.Registered_Delivery === 1) {
            obj.Msg_Content = this.readBody('CMPP_DELIVER_REPORT_CONTENT', obj.Msg_Content)
        }
        else {
            obj.Msg_Content = obj.Msg_Content.toString('gbk')
        }
    }
    return obj
  }

  getBodyBuffer(command, body) {
    const _this = this
    const buffer = new Buffer(1024 * 1024)
    buffer.fill(0)
    const commandStr = cmdCfg.Commands[command]
    const commandDesp = cmdCfg.CommandsDescription[commandStr]
    if (!commandDesp)
        return buffer.slice(0, 0)
    body._length = 0
    commandDesp.forEach(function (field) {
        _this.writeBuf(buffer, field, body)
    })
    return buffer.slice(0, body._length)
  }

  getValue(buffer, field, obj) {
    const length = obj._length || 0
    if (length >= buffer.length)
        return
    const fieldLength = this.getLength(field, obj)
    obj._length = length + fieldLength
    if (field.type === 'number') {
        const bitLength = fieldLength * 8
        let method = 'readUInt' + bitLength + 'BE'
        if (bitLength === 8)
            method = 'readUInt' + bitLength
        return buffer[method](length)
    }
    else if (field.type === 'string') {
        const value = buffer.toString(field.encoding || 'ascii', length, length + fieldLength)
        return value.replace(/\0+$/, '')
    }
    else if (field.type === 'buffer') {
        return buffer.slice(length, length + fieldLength)
    }
  }

  writeBuf(buffer, field, body) {
    const length = body._length || 0
    const fieldLength = this.getLength(field, body)
    let value = body[field.name]
    body._length = length + fieldLength
    if (value instanceof Buffer) {
        value.copy(buffer, length, 0, fieldLength)
    }
    else {
        if (field.type === 'number' && _.isNumber(value)) {
            const bitLength = fieldLength * 8
            let method = 'writeUInt' + bitLength + 'BE'
            if (bitLength === 8)
                method = 'writeUInt' + bitLength
            buffer[method](value, length)
        }
        else if (field.type === 'string') {
            if (!value)
                value = ''
            buffer.write(value, length, fieldLength, field.encoding || 'ascii')
        }
    }
  }

  getLength(field, obj) {
    if (_.isFunction(field.length)) {
      return field.length(obj)
    }
    return field.length
  }
}

CMPPSocket.Commands = cmdCfg.Commands
module.exports = CMPPSocket