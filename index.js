'use strict';

var util = require('util');
var EventEmitter = require('events').EventEmitter;
var includes = require('lodash.includes');
var debug = require('debug')('remote-io');

var FIRMWARE_NAME = 'VirtualFirmata';
var FIRMWARE_VERSION_MAJOR = 2;
var FIRMWARE_VERSION_MINOR = 3;
var IO_NAME = 'Firmata'; //this helps johnny-five do pin mapping

function pad(n, width, z) {
  z = z || '0';
  n = n + '';
  return n.length >= width ? n : new Array(width - n.length + 1).join(z) + n;
}

function format(byt){
  return pad(new Number(byt).toString(2), 8);
}

/**
 * constants
 *
 * I really dont want these here, but they're not exported from the firmata.js package
 *
**/

var ANALOG_MAPPING_QUERY = 0x69,
ANALOG_MAPPING_RESPONSE = 0x6A,
ANALOG_MESSAGE = 0xE0,
CAPABILITY_QUERY = 0x6B,
CAPABILITY_RESPONSE = 0x6C,
DIGITAL_MESSAGE = 0x90,
END_SYSEX = 0xF7,
EXTENDED_ANALOG = 0x6F,
I2C_CONFIG = 0x78,
I2C_REPLY = 0x77,
I2C_REQUEST = 0x76,
ONEWIRE_CONFIG_REQUEST = 0x41,
ONEWIRE_DATA = 0x73,
ONEWIRE_DELAY_REQUEST_BIT = 0x10,
ONEWIRE_READ_REPLY = 0x43,
ONEWIRE_READ_REQUEST_BIT = 0x08,
ONEWIRE_RESET_REQUEST_BIT = 0x01,
ONEWIRE_SEARCH_ALARMS_REPLY = 0x45,
ONEWIRE_SEARCH_ALARMS_REQUEST = 0x44,
ONEWIRE_SEARCH_REPLY = 0x42,
ONEWIRE_SEARCH_REQUEST = 0x40,
ONEWIRE_WITHDATA_REQUEST_BITS = 0x3C,
ONEWIRE_WRITE_REQUEST_BIT = 0x20,
PIN_MODE = 0xF4,
PIN_STATE_QUERY = 0x6D,
PIN_STATE_RESPONSE = 0x6E,
PULSE_IN = 0x74,
PULSE_OUT = 0x73,
QUERY_FIRMWARE = 0x79,
REPORT_ANALOG = 0xC0,
REPORT_DIGITAL = 0xD0,
REPORT_VERSION = 0xF9,
SAMPLING_INTERVAL = 0x7A,
SERVO_CONFIG = 0x70,
START_SYSEX = 0xF0,
STEPPER = 0x72,
STRING_DATA = 0x71,
SYSTEM_RESET = 0xFF;

var MODES = {
  INPUT: 0x00,
  OUTPUT: 0x01,
  ANALOG: 0x02,
  PWM: 0x03,
  SERVO: 0x04,
  SHIFT: 0x05,
  I2C: 0x06,
  ONEWIRE: 0x07,
  STEPPER: 0x08,
  IGNORE: 0x7F,
  UNKOWN: 0x10
};

var I2C_MODES = {
  WRITE: 0x00,
  READ: 1,
  CONTINUOUS_READ: 2,
  STOP_READING: 3
};



/**
 * MIDI_REQUEST contains functions to be called when we receive a MIDI message from over the wire.
 * used as a switch object as seen here http://james.padolsey.com/javascript/how-to-avoid-switch-case-syndrome/
 * @private
 */

var MIDI_REQUEST = {};

/**
 * Handles a REPORT_VERSION response and emits the reportversion event.
 * @private
 * @param {Board} board the current arduino board we are working with.
 */

MIDI_REQUEST[REPORT_VERSION] = function(board) {
  var versionBytes = new Buffer([REPORT_VERSION, FIRMWARE_VERSION_MAJOR, FIRMWARE_VERSION_MINOR]);
  board.sp.write(versionBytes);
};

MIDI_REQUEST[SYSTEM_RESET] = function(board) {
  debug('MIDI_REQUEST[SYSTEM_RESET]');
  board.io.reset();
};

MIDI_REQUEST[REPORT_DIGITAL] = function(board) {
  debug('MIDI_REQUEST[REPORT_DIGITAL]', board.currentBuffer);

  var port = board.currentBuffer[0] & 0x0F;
  var value = board.currentBuffer[1];

  for (var i = 0; i < 8; i++) {
    var pinNumber = 8 * port + i;
    if(value){

      //only need to register this once.
      //TODO check if this is the case for IOs other than firmata
      if(!board.digitalCallbacks[pinNumber]){

        board.digitalCallbacks[pinNumber] = function(data){
          debug('digital data message recieved', data);

          //TODO send out digital message to serial port if data changed

          // var msg = Buffer.concat([new Buffer([DIGITAL_MESSAGE | port])
          // debug('sending digital to serial', msg);
          // board.sp.write(msg);
        };

        board.io.analogRead(pinNumber, board.digitalCallbacks[pinNumber]);
      }


    }else{
      board.io.reportDigitalPin(pinNumber, reportState);
    }
  }

};

MIDI_REQUEST[REPORT_ANALOG] = function(board) {

  var pinNumber = board.currentBuffer[0] - 0xC0;
  var reportState = board.currentBuffer[1];

  debug('MIDI_REQUEST[REPORT_ANALOG]', pinNumber, reportState);



  if(reportState){

    //only need to register this once.
    //TODO check if this is the case for IOs other than firmata
    if(!board.analogCallbacks[pinNumber]){

      board.analogCallbacks[pinNumber] = function(data){
        var msg = Buffer.concat([new Buffer([ANALOG_MESSAGE | pinNumber]) , sendValueAsTwo7bitBytes(data)]);
        debug('sending analog to serial', msg);
        board.sp.write(msg);
      };

      board.io.analogRead(pinNumber, board.analogCallbacks[pinNumber]);
    }


  }else{
    board.io.reportAnalogPin(pinNumber, reportState);
  }


};

/**
 * Handles a ANALOG_MESSAGE response and emits "analog-read" and "analog-read-"+n events where n is the pin number.
 * @private
 * @param {Board} board the current arduino board we are working with.
 */

MIDI_REQUEST[ANALOG_MESSAGE] = function(board) {
  var value = board.currentBuffer[1] | (board.currentBuffer[2] << 7);
  var pin = board.currentBuffer[0] & 0x0F;
  //debug('MIDI_REQUEST[ANALOG_MESSAGE]', value, pin);
  board.io.analogWrite(pin, value);
};

/**
 * Handles a DIGITAL_MESSAGE response:
 *
 */

MIDI_REQUEST[DIGITAL_MESSAGE] = function(board) {
  var port = (board.currentBuffer[0] & 0x0F);
  var portValue = board.currentBuffer[1] | (board.currentBuffer[2] << 7);

  //TODO: probably a much more effecient way to do this than string manipulation
  var values = format(portValue).split('').map(function(val){ return parseInt(val,10); }).reverse();

  debug('MIDI_REQUEST[DIGITAL_MESSAGE]', board.currentBuffer, port, values);

  for (var i = 0; i < 8; i++) {
    var pinNumber = 8 * port + i;
    var pin = board.io.pins[pinNumber];
    if(pin){
      if(pin.value !== values[i]){
        debug('MIDI_REQUEST[DIGITAL_MESSAGE] writing', pinNumber, values[i]);
        try{
          board.io.digitalWrite(pinNumber, values[i]);
        }catch(exp){
          debug('error digitalWriting', pinNumber, values[i], exp);
        }
      }
      pin.value = values[i];
    }
  }
};



/**
 * Handles a PIN response:
 *
 */

MIDI_REQUEST[PIN_MODE] = function(board) {
  var pinNumber = board.currentBuffer[1];
  var pinMode = board.currentBuffer[2];

  debug('MIDI_REQUEST[PIN_MODE]', pinNumber, pinMode);

  var pin = board.io.pins[pinNumber];
  if(pin){ //} && board.io.MODES[pinMode]){
    debug('MIDI_REQUEST[PIN_MODE] write');
    //board.io.pins[pinNumber].mode = pinMode;
    board.io.pinMode(pinNumber, pinMode);
  }

};

/**
 * SYSEX_REQUEST contains functions to be called when we receive a SYSEX message from the arduino.
 * used as a switch object as seen here http://james.padolsey.com/javascript/how-to-avoid-switch-case-syndrome/
 * @private
 */

var SYSEX_REQUEST = {};



function printFirmwareVersion(){
  var buf = new Buffer([START_SYSEX,QUERY_FIRMWARE, FIRMWARE_VERSION_MAJOR, FIRMWARE_VERSION_MINOR]);
  debug(buf.length, 'fwv', buf.toString('hex'));
  for (var i = 0; i < FIRMWARE_NAME.length; i++) {
    //debug('FIRMWARE_NAME.charCodeAt(i)', i, FIRMWARE_NAME.charCodeAt(i));
    buf = Buffer.concat([buf, sendValueAsTwo7bitBytes(FIRMWARE_NAME.charCodeAt(i)) ]);
    // debug(buf.length, 'fwv', buf.toString('hex'));
  };
  //buf.write(new Buffer(END_SYSEX));
  buf = Buffer.concat([buf, new Buffer([END_SYSEX])]);

  debug(buf.length, 'fwv', buf.toString('hex'));
  return buf;

}


function sendValueAsTwo7bitBytes(value){
  return new Buffer([value & 0x7f, value >> 7 & 0x7f]);
}


/**
 * Handles a QUERY_FIRMWARE response and emits the "queryfirmware" event
 * @private
 * @param {Board} board the current arduino board we are working with.
 */

SYSEX_REQUEST[QUERY_FIRMWARE] = function(board) {

  debug('SYSEX_REQUEST[QUERY_FIRMWARE]');
  var buf = new Buffer([REPORT_VERSION, 2, 3]);
  buf = Buffer.concat([buf, printFirmwareVersion()]);
  debug('buf', buf);
  board.sp.write(buf);
};



SYSEX_REQUEST[CAPABILITY_QUERY] = function(board){

  function writeCapabilites(){
    var output = [START_SYSEX,CAPABILITY_RESPONSE];
    //debug('SYSEX_REQUEST[CAPABILITY_QUERY]', board.io.pins.length);
    for (var i = 0; i < board.io.pins.length; i++) {
      var pin = board.io.pins[i];
      //debug(i, JSON.stringify(pin));
      if (includes(pin.supportedModes, MODES.OUTPUT)) {
        output.push(MODES.INPUT);
        output.push(1);
        output.push(MODES.OUTPUT);
        output.push(1);
      }
      if (includes(pin.supportedModes, MODES.ANALOG)) {
        output.push(MODES.ANALOG);
        output.push(10);
      }
      if (includes(pin.supportedModes, MODES.PWM)) {
        output.push(MODES.PWM);
        output.push(8);
      }
      if (includes(pin.supportedModes, MODES.SERVO)) {
        output.push(MODES.SERVO);
        output.push(14);
      }
      if (includes(pin.supportedModes, MODES.I2C)) {
        output.push(MODES.I2C);
        output.push(1);  // to do: determine appropriate value
      }
      output.push(127);
    }
    output.push(END_SYSEX);

    board.sp.write(new Buffer(output));
  }

  if(board.io.pins && board.io.pins.length > 0){
    writeCapabilites();
  }else{
    board.io.queryCapabilities(function(err, data){
      writeCapabilites();
    });
  }
}


SYSEX_REQUEST[ANALOG_MAPPING_QUERY] = function(board){

  function writeMappings(){
    debug('SYSEX_REQUEST[ANALOG_MAPPING_QUERY]');

    var output = [START_SYSEX,ANALOG_MAPPING_RESPONSE];
    for (var i = 0; i < board.io.pins.length; i++) {
      var pin = board.io.pins[i];
      output.push(pin.analogChannel);
    }
    output.push(END_SYSEX);

    board.sp.write(new Buffer(output));
    debug('ANALOG_MAPPING_QUERY done');
  }

  if(board.io.queryAnalogMapping){
    board.io.queryAnalogMapping(writeMappings);
  }else{
    writeMappings();
  }

}

SYSEX_REQUEST[SAMPLING_INTERVAL] = function(board){
  var value = board.currentBuffer[2] | (board.currentBuffer[3] << 7);

  debug('SYSEX_REQUEST[SAMPLING_INTERVAL]', board.currentBuffer, 'value', value);

  if(board.io.setSamplingInterval){
    board.io.setSamplingInterval(value);
  }else{
    debug('io does not support setSamplingInterval');
  }
}

SYSEX_REQUEST[SERVO_CONFIG] = function(board){
  var pin = board.currentBuffer[2];
  var min = board.currentBuffer[3] | (board.currentBuffer[4] << 7);
  var max = board.currentBuffer[5] | (board.currentBuffer[6] << 7);

  debug('SYSEX_REQUEST[SERVO_CONFIG] pin', pin, 'min', min, 'max', max);

  if(board.io.servoConfig){
    board.io.servoConfig(pin, min, max);
  }else{
    debug('io does not support servoConfig');
  }
}

SYSEX_REQUEST[EXTENDED_ANALOG] = function(board){
  var pin = board.currentBuffer[2];
  var value = board.currentBuffer[3]; // | (board.currentBuffer[4] << 7);

  var MSBs = board.currentBuffer.length - 5;

  for (var i = 0; i < MSBs; i++) {
    value = value | board.currentBuffer[4 + i] << ((i + 1) * 7);
  }

  debug('SYSEX_REQUEST[EXTENDED_ANALOG] pin', pin, 'value', value);

  board.io.analogWrite(pin, value);
}


/**
 * Handles a PIN_STATE response and emits the 'pin-state-'+n event where n is the pin number.
 *
 * Note about pin state: For output modes, the state is any value that has been
 * previously written to the pin. For input modes, the state is the status of
 * the pullup resistor.
 * @private
 * @param {Board} board the current arduino board we are working with.
 */

SYSEX_REQUEST[PIN_STATE_QUERY] = function (board) {
  debug('SYSEX_REQUEST[PIN_STATE_QUERY] not implemented', board.currentBuffer);

  //TODO - handle this

  // var pin = board.currentBuffer[2];
  // board.pins[pin].mode = board.currentBuffer[3];
  // board.pins[pin].state = board.currentBuffer[4];
  // if (board.currentBuffer.length > 6) {
  //   board.pins[pin].state |= (board.currentBuffer[5] << 7);
  // }
  // if (board.currentBuffer.length > 7) {
  //   board.pins[pin].state |= (board.currentBuffer[6] << 14);
  // }
  // board.emit("pin-state-" + pin);
};


SYSEX_REQUEST[I2C_REPLY] = function(board) {
  debug('SYSEX_REQUEST[I2C_REPLY] not implemented', board.currentBuffer);
};


SYSEX_REQUEST[I2C_REQUEST] = function(board) {

  var address = board.currentBuffer[2];
  var mode = board.currentBuffer[3] >> 3;
  var byteLength = (board.currentBuffer.length - 5) / 2;

  var data = [];
  for (var i = 0; i < byteLength; i++) {
    data.push(board.currentBuffer[(i * 2) + 4] | (board.currentBuffer[(i * 2) + 5] << 7));
  }

  debug('SYSEX_REQUEST[I2C_REQUEST]', 'address', address, 'mode', mode, 'byteLength', byteLength, 'data', data);

  if(mode === I2C_MODES.WRITE){
    if(board.io.i2cWrite){
      board.io.i2cWrite(address, data);
    }else{
      debug('board does not support i2cWrite');
    }

  }else if(mode === I2C_MODES.READ){
    debug('SYSEX_REQUEST[I2C_REQUEST] READ not implemented yet', board.currentBuffer);

    if(board.io.i2cReadOnce){
      var register = data[0];
      var numBytes = data[1];
      board.io.i2cReadOnce(address, register, numBytes, function(resp){

        var reply = [
          START_SYSEX,
          I2C_REPLY,
          address & 0x7f,
          address >> 7 & 0x7f,
          register & 0x7f,
          register >> 7 & 0x7f
        ];

        for (var i = 0; i < resp.length; i++) {
          reply.push(resp[i] & 0x7f)
          reply.push(resp[i] >> 7 & 0x7f);
        }

        reply.push(END_SYSEX);

        var buf = new Buffer(reply);

        board.sp.write(buf);

      });
    }else{
      debug('board does not support i2cReadOnce');
    }


  }else if(mode === I2C_MODES.CONTINUOUS_READ){
    if(board.io.i2cRead){
      var register = data[0];
      var numBytes = data[1];
      board.io.i2cRead(address, register, numBytes, function(resp){

        var reply = [
          START_SYSEX,
          I2C_REPLY,
          address & 0x7f,
          address >> 7 & 0x7f,
          register & 0x7f,
          register >> 7 & 0x7f
        ];

        for (var i = 0; i < resp.length; i++) {
          reply.push(resp[i] & 0x7f)
          reply.push(resp[i] >> 7 & 0x7f);
        }

        reply.push(END_SYSEX);

        var buf = new Buffer(reply);

        board.sp.write(buf);

      });
    }else{
      debug('board does not support i2cRead');
    }

  }else if(mode === I2C_MODES.STOP_READING){
    debug('SYSEX_REQUEST[I2C_REQUEST] READ not implemented yet', board.currentBuffer);
  }

};

SYSEX_REQUEST[I2C_CONFIG] = function(board) {
  var value = board.currentBuffer[2] | (board.currentBuffer[3] << 7);
  debug('SYSEX_REQUEST[I2C_CONFIG] delay', value);
  if(board.io.i2cConfig){
    board.io.i2cConfig(value);
  }
};

SYSEX_REQUEST[ONEWIRE_DATA] = function(board) {
  debug('SYSEX_REQUEST[ONEWIRE_DATA] not implemented yet');
  //TODO handle this

  // var subCommand = board.currentBuffer[2];

  // if (!SYSEX_REQUEST[subCommand]) {
  //   return;
  // }

  // SYSEX_REQUEST[subCommand](board);
};

SYSEX_REQUEST[ONEWIRE_SEARCH_REPLY] = function(board) {
  debug('SYSEX_REQUEST[ONEWIRE_SEARCH_REPLY] not implemented yet');
  //TODO handle this

  // var pin = board.currentBuffer[3];
  // var replyBuffer = board.currentBuffer.slice(4, board.currentBuffer.length - 1);

  // board.emit("1-wire-search-reply-" + pin, OneWireUtils.readDevices(replyBuffer));
};

SYSEX_REQUEST[ONEWIRE_SEARCH_ALARMS_REPLY] = function(board) {
  debug('SYSEX_REQUEST[ONEWIRE_SEARCH_ALARMS_REPLY] not implemented yet');
  //TODO handle this

  // var pin = board.currentBuffer[3];
  // var replyBuffer = board.currentBuffer.slice(4, board.currentBuffer.length - 1);

  // board.emit("1-wire-search-alarms-reply-" + pin, OneWireUtils.readDevices(replyBuffer));
};

SYSEX_REQUEST[ONEWIRE_READ_REPLY] = function(board) {
  debug('SYSEX_REQUEST[ONEWIRE_READ_REPLY] not implemented yet');
  //TODO handle this

  // var encoded = board.currentBuffer.slice(4, board.currentBuffer.length - 1);
  // var decoded = Encoder7Bit.from7BitArray(encoded);
  // var correlationId = (decoded[1] << 8) | decoded[0];

  // board.emit("1-wire-read-reply-" + correlationId, decoded.slice(2));
};

/**
 * Handles a STRING_DATA response and logs the string to the console.
 * @private
 * @param {Board} board the current arduino board we are working with.
 */

SYSEX_REQUEST[STRING_DATA] = function(board) {
  debug('SYSEX_REQUEST[STRING_DATA] not implemented yet');
  //TODO handle this

  // var string = new Buffer(board.currentBuffer.slice(2, -1)).toString("utf8").replace(/\0/g, "");
  // board.emit("string", string);
};

/**
 * Response from pulseIn
 */

SYSEX_REQUEST[PULSE_IN] = function(board) {
  debug('SYSEX_REQUEST[PULSE_IN] not implemented yet');
  //TODO handle this

  // var pin = (board.currentBuffer[2] & 0x7F) | ((board.currentBuffer[3] & 0x7F) << 7);
  // var durationBuffer = [
  //   (board.currentBuffer[4] & 0x7F) | ((board.currentBuffer[5] & 0x7F) << 7), (board.currentBuffer[6] & 0x7F) | ((board.currentBuffer[7] & 0x7F) << 7), (board.currentBuffer[8] & 0x7F) | ((board.currentBuffer[9] & 0x7F) << 7), (board.currentBuffer[10] & 0x7F) | ((board.currentBuffer[11] & 0x7F) << 7)
  // ];
  // var duration = ((durationBuffer[0] << 24) +
  //   (durationBuffer[1] << 16) +
  //   (durationBuffer[2] << 8) +
  //   (durationBuffer[3]));
  // board.emit("pulse-in-" + pin, duration);
};


/**
 * Request for a pulse
 */

SYSEX_REQUEST[PULSE_OUT] = function(board) {
  debug('SYSEX_REQUEST[PULSE_OUT] not implemented yet');
  //TODO handle this

};

/**
 * Handles the message from a stepper completing move
 * @param {Board} board
 */

SYSEX_REQUEST[STEPPER] = function(board) {
  debug('SYSEX_REQUEST[STEPPER] not implemented yet');
  //TODO handle this

  // var deviceNum = board.currentBuffer[2];
  // board.emit("stepper-done-" + deviceNum, true);
};





function IOClient(options) {
  this.name = IO_NAME;
  this.io = options.io;
  this.sp = options.serial;

  this.currentBuffer = [];

  this.analogCallbacks = [];
  this.digitalCallbacks = [];

  var self = this;


  this.sp.on('data', function(data) {
    var byt, cmd;

    debug('remote data in', data, data.length);



    for (var i = 0; i < data.length; i++) {
      byt = data[i];

      //debug('byt', byt);


      // we dont want to push 0 as the first byte on our buffer
      if (self.currentBuffer.length === 0 && byt === 0) {
        continue;
      } else {

        if (i === 0 && includes([REPORT_VERSION, SYSTEM_RESET], byt)) {
          debug('one byte command', new Buffer([byt]));
          try{
            MIDI_REQUEST[byt](self);
          }catch(err){
            debug('error running one byte command: ' + new Buffer([byt]), err );
          }
        }
        else{
          self.currentBuffer.push(byt);
          //debug('self.currentBuffer', new Buffer(self.currentBuffer).toString('hex'));
        }


        // [START_SYSEX, ... END_SYSEX]
        if (self.currentBuffer[0] === START_SYSEX &&
          self.currentBuffer[1] &&
          self.currentBuffer[self.currentBuffer.length - 1] === END_SYSEX) {


          if(SYSEX_REQUEST[self.currentBuffer[1]]){
            debug('handling sysex', new Buffer(self.currentBuffer), new Buffer([self.currentBuffer[1], QUERY_FIRMWARE]));
            try{
              SYSEX_REQUEST[self.currentBuffer[1]](self);
            }catch(exp){
              debug('error handling sysex', exp);
            }
            debug('handled');
          }
          else{
            debug('unhandled SYSEX', self.currentBuffer)
          }
          self.currentBuffer = [];



        } else if (self.currentBuffer[0] !== START_SYSEX) {
          // Check if data gets out of sync: first byte in buffer
          // must be a valid command if not START_SYSEX
          // Identify command on first byte
          cmd = self.currentBuffer[0] < 240 ? self.currentBuffer[0] & 0xF0 : self.currentBuffer[0];

          // Check if it is not a valid command
          if (cmd !== REPORT_VERSION && cmd !== ANALOG_MESSAGE && cmd !== DIGITAL_MESSAGE) {
            //debug("OUT OF SYNC - CMD: "+cmd);
            // Clean buffer
            //self.currentBuffer.length = 0;
          }
        }


        // There are 2 bytes in the buffer and the first is not START_SYSEX:
        // Might have a 2 byte Command
        if (self.currentBuffer.length === 2 && self.currentBuffer[0] !== START_SYSEX) {
          debug('2 byte check', self.currentBuffer);
          try{
            if(self.currentBuffer[0] >= 0xC0 && self.currentBuffer[0] <= 0xCF){
              MIDI_REQUEST[REPORT_ANALOG](self);
              self.currentBuffer.length = 0;
            }
            else if(self.currentBuffer[0] >= 0xD0 && self.currentBuffer[0] <= 0xDF){
              MIDI_REQUEST[REPORT_DIGITAL](self);
              self.currentBuffer.length = 0;
          }
          }catch(exp){
            debug('err handling reports', exp);
          }

        }


        // There are 3 bytes in the buffer and the first is not START_SYSEX:
        // Might have a MIDI Command
        if (self.currentBuffer.length === 3 && self.currentBuffer[0] !== START_SYSEX) {
          //commands under 0xF0 we have a multi byte command
          if (self.currentBuffer[0] < 240) {
            cmd = self.currentBuffer[0] & 0xF0;
          } else {
            cmd = self.currentBuffer[0];
          }

          //debug('MIDI?', cmd);

          if (MIDI_REQUEST[cmd]) {
            debug('MIDI', cmd);
            try{
              MIDI_REQUEST[cmd](self);
            }
            catch(err){
              debug('error handling MIDI_REQUEST', cmd, err);
            }
            self.currentBuffer.length = 0;
          } else {
            // A bad serial read must have happened.
            // Reseting the buffer will allow recovery.
            self.currentBuffer.length = 0;
          }
        }
      }
    }

    //debug('cmd in', cmd, new Buffer(self.currentBuffer).toString('hex'));

  }.bind(this));



}

util.inherits(IOClient, EventEmitter);

module.exports = IOClient;
