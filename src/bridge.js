#!/usr/bin/env node

const pkg = require('../package.json')
const log = require('yalm')
const config = require('./config.js')
const mqtt = require('mqtt')
const SONOS = require('sonos')

let mqttClient
let search
let devices = []

function start () {
  log.setLevel(config.verbosity)
  log.info(pkg.name + ' ' + pkg.version + ' starting')

  // MQTT Stuff
  // Define the will message (is send on disconnect).
  const mqttOptions = {
    will: {
      topic: config.name + '/connected',
      message: 0,
      qos: 0,
      retain: true
    }
  }

  mqttClient = mqtt.connect(config.url, mqttOptions)

  mqttClient.on('connect', () => {
    log.info('Connected to mqtt %s', config.url)
    mqttClient.subscribe(config.name + '/set/+/+')
    mqttClient.subscribe(config.name + '/cmd/+')
  })

  mqttClient.on('message', handleIncomingMessage)

  mqttClient.on('close', () => {
    log.info('mqtt closed ' + config.mqtt)
  })

  mqttClient.on('error', err => {
    log.error('mqtt', err.toString())
  })

  mqttClient.on('offline', () => {
    log.error('mqtt offline')
  })

  mqttClient.on('reconnect', () => {
    log.info('mqtt reconnect')
  })

  // Start searching for devices
  log.info('Start searching for Sonos players')
  search = SONOS.DeviceDiscovery({timeout: 4000})
  search.on('DeviceAvailable', (device, model) => {
    log.debug('Found device (%s) with IP: %s', model, device.host)

    device.getZoneAttrs().then(attrs => {
      log.info('Found player (%s): %s with IP: %s', model, attrs.CurrentZoneName, device.host)
      device.name = attrs.CurrentZoneName
      // hosts.push(host)
      addDevice(device)
    }).catch(err => {
      log.error('Get Zone error ', err)
    })
  })

  search.on('timeout', () => {
    publishConnectionStatus()
  })

  SONOS.Listener.on('AlarmClock', result => {
    log.debug('Alarms changed (or loaded for the first time)')
    listAlarms()
  })

  process.on('SIGINT', () => {
    log.info('Shutting down listeners, please wait')
    SONOS.Listener.stopListener().then(result => {
      log.info('Listener shutdown successfully')
      process.exit()
    }).catch(err => {
      log.error('Error shutting down listner %j', err)
      setTimeout(() => {
        process.exit()
      }, 2000)
    })
  })
}

// This function will receive all incoming messages from MQTT
async function handleIncomingMessage (topic, payload) {
  payload = payload.toString()
  log.debug('Incoming message to %s %j', topic, payload)

  const parts = topic.toLowerCase().split('/')

  // Commands for devices
  if (parts[1] === 'set' && parts.length === 4) {
    let device = devices.find((device) => { return device.name.toLowerCase() === parts[2] })
    if (device) {
      return handleDeviceCommand(device, parts[3], payload).catch(err => {
        log.error('Error handling command %j', err)
      })
    } else {
      log.error('Device with name %s not found', parts[2])
      return false
    }
  } else if (parts[1] === 'cmd' && parts.length === 3) {
    return handleGenericCommand(parts[2], payload)
  }
}

// This function is called when a device command is recognized by 'handleIncomingMessage'
async function handleDeviceCommand (device, command, payload) {
  log.debug('Incoming device command %s for %s payload %s', command, device.name, payload)
  switch (command) {
    // ------------------ Playback commands
    case 'next':
      return device.next()
    case 'pause':
    case 'pauze':
      return device.pause()
    case 'play':
      return device.play()
    case 'previous':
      return device.previous()
    case 'stop':
      return device.stop()
    // ------------------ Volume commands
    case 'volume':
      if (IsNumeric(payload)) {
        var vol = parseInt(payload)
        if (vol >= 0 && vol <= 100) {
          return device.setVolume(vol).then(res => {
            log.info('Changed volume to %d', vol)
          })
        }
      } else {
        log.error('Payload for setting volume is not numeric')
        return false
      }
      break
    case 'volumeup':
      return handleVolumeCommand(device, payload, 1)
    case 'volumedown':
      return handleVolumeCommand(device, payload, -1)
    case 'mute':
      return device.setMuted(true)
    case 'unmute':
      return device.setMuted(false)
    // ------------------ Sleeptimer
    case 'sleep':
      if (IsNumeric(payload)) {
        var minutes = parseInt(payload)
        if (minutes > 0 && minutes < 1000) {
          return device.configureSleepTimer(minutes)
        }
      } else {
        log.error('Payload for setting sleeptimer is not numeric')
        return false
      }
      break
    default:
      log.debug('Command %s not yet supported', command)
      break
  }
  return false
}

 // This function is used by 'handleDeviceCommand' for handeling the volume up/down commands
async function handleVolumeCommand (device, payload, modifier) {
  let change = 5
  if (IsNumeric(payload)) {
    let tempIncrement = parseInt(payload)
    if (tempIncrement > 0 && tempIncrement < 100) {
      change = tempIncrement
    }
  }
  let volume = 0
  let newVolume = 0
  return device.getVolume().then(vol => {
    volume = vol
    newVolume = vol + (change * modifier)
    return newVolume
  }).then(device.setVolume).then(result => {
    log.info('Volume modified from %d to %d', volume, newVolume)
  }).catch(err => {
    log.error('Error getting/setting volume', err)
  })
}

// This function is called when a generic command is recognized by 'handleIncomingMessages'
async function handleGenericCommand (command, payload) {
  switch (command) {
    // ------------------ Alarms
    case 'listalarms':
      return listAlarms()
    // ------------------ Control all devices
    case 'pauseall':
      let pause = function (device) {
        return devices.pause()
      }
      let pauseAll = devices.map(pause)
      return Promise.all(pauseAll).catch(err => {
        log.debug('Error pausing all devices %j', err)
      })

    default:
      log.error('Command %s isn\' implemented', command)
      break
  }
  return false
}

// Loading the alarms and publishing them to 'sonos/alarms'
async function listAlarms () {
  var alarmService = devices[0].alarmClockService()
  return alarmService.ListAlarms().then(alarmResult => {
    log.debug('Got alarms %j', alarmResult.CurrentAlarmList)
    // For better reading we remove the metadata.
    // alarmResult.CurrentAlarmList(alarm => {
    //   delete alarm.ProgramMetaData
    // })
    publishData(config.name + '/alarms', alarmResult.CurrentAlarmList)
  }).catch(err => {
    log.error('Error loading alarms from %s %j', devices[0].host, err)
  })
}

function publishConnectionStatus () {
  let status = '1'
  if (devices.length > 0) { status = '2' }
  mqttClient.publish(config.name + '/connected', status, {
    qos: 0,
    retain: true
  })
}

// This function is called by the device discovery, used to setup listening for certain events.
function addDevice (device) {
  // Start listening for those events!
  device.on('CurrentTrack', track => {
    publishCurrentTrack(device, track)
  })
  device.on('PlayState', state => {
    publishState(device, state)
  })
  device.on('Mute', muted => {
    publishMuted(device, muted)
  })
  device.on('Volume', volume => {
    publishVolume(device, volume)
  })

  devices.push(device)
}

// Used by event handler
function publishVolume (device, volume) {
  publishData(config.name + '/status/' + device.name + '/volume', volume, device.name, true)
}

// Used by event handler
function publishMuted (device, muted) {
  publishData(config.name + '/status/' + device.name + '/muted', muted, device.name, true)
}

// Used by event handler
function publishState (device, state) {
  publishData(config.name + '/status/' + device.name + '/state', state, device.name, true)
}

// Used by event handler
function publishCurrentTrack (device, track) {
  log.debug('New track data for %s %j', device.name, track)
  if (config.publishDistinct) {
    publishData(config.name + '/status/' + device.name + '/title', track.title, device.name)
    publishData(config.name + '/status/' + device.name + '/artist', track.artist, device.name)
    publishData(config.name + '/status/' + device.name + '/album', track.album, device.name)
    publishData(config.name + '/status/' + device.name + '/albumart', track.albumArtURL, device.name)
    publishData(config.name + '/status/' + device.name + '/trackuri', track.uri, device.name)
  } else {
    publishData(config.name + '/status/' + device.name + '/track', track, device.name)
  }
}

// This function will format the data before publishing to mqtt
function publishData (topic, dataVal, name = null, retain = false) {
  if (mqttClient.connected) {
    let data = null
    if (dataVal != null) {
      data = {
        ts: new Date(),
        name: name,
        val: dataVal
      }
    }
    mqttClient.publish(topic, JSON.stringify(data), {retain: retain})
    log.debug('Published to %s', topic)
  } else {
    log.debug('Couldn\'t publish to %s because not connected', topic)
  }
}

// This function is used to check certain input parameters to be numbers
function IsNumeric (val) {
  return !isNaN(parseInt(val))
}

start()
