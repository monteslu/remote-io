'use strict';

var util = require('util');
var EventEmitter = require('events').EventEmitter;
var _ = require('lodash');

var FIRMWARE_NAME = 'VirtualFirmata';
var FIRMWARE_VERSION_MAJOR = 2;
var FIRMWARE_VERSION_MINOR = 3;

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





/**
 * MIDI_RESPONSE contains functions to be called when we receive a MIDI message from the arduino.
 * used as a switch object as seen here http://james.padolsey.com/javascript/how-to-avoid-switch-case-syndrome/
 * @private
 */

var MIDI_RESPONSE = {};

/**
 * Handles a REPORT_VERSION response and emits the reportversion event.  Also turns on all pins to start reporting
 * @private
 * @param {Board} board the current arduino board we are working with.
 */

MIDI_RESPONSE[REPORT_VERSION] = function(board) {
  var versionBytes = new Buffer([ REPORT_VERSION, FIRMWARE_VERSION_MAJOR, FIRMWARE_VERSION_MINOR]);
  board.sp.write(versionBytes);
};

MIDI_RESPONSE[SYSTEM_RESET] = function(board) {
  console.log('MIDI_RESPONSE[SYSTEM_RESET]');
  board.io.reset();
};

/**
 * Handles a ANALOG_MESSAGE response and emits "analog-read" and "analog-read-"+n events where n is the pin number.
 * @private
 * @param {Board} board the current arduino board we are working with.
 */

MIDI_RESPONSE[ANALOG_MESSAGE] = function(board) {
  var value = board.currentBuffer[1] | (board.currentBuffer[2] << 7);
  var pin = board.currentBuffer[0] & 0x0F;
  //console.log('MIDI_RESPONSE[ANALOG_MESSAGE]', value, pin);
  board.io.analogWrite(pin, value);
};

/**
 * Handles a DIGITAL_MESSAGE response:
 *
 */

MIDI_RESPONSE[DIGITAL_MESSAGE] = function(board) {
  var port = (board.currentBuffer[0] & 0x0F);
  var portValue = board.currentBuffer[1] | (board.currentBuffer[2] << 7);

  //TODO: probably a much more effecient way to do this than string manipulation
  var values = format(portValue).split('').map(function(val){ return parseInt(val,10); }).reverse();

  console.log('MIDI_RESPONSE[DIGITAL_MESSAGE]', board.currentBuffer, port, values);

  for (var i = 0; i < 8; i++) {
    var pinNumber = 8 * port + i;
    var pin = board.io.pins[pinNumber];
    if(pin){
      if(pin.value !== values[i]){
        console.log('MIDI_RESPONSE[DIGITAL_MESSAGE] writing', pinNumber, values[i]);
        board.io.digitalWrite(pinNumber, values[i]);
      }
      pin.value = values[i];
    }
  }
};



/**
 * Handles a PIN response:
 *
 */

MIDI_RESPONSE[PIN_MODE] = function(board) {
  var pinNumber = board.currentBuffer[1];
  var pinMode = board.currentBuffer[2];

  var pin = board.io.pins[pinNumber];
  if(pin){ //} && board.io.MODES[pinMode]){
    console.log('MIDI_RESPONSE[PIN_MODE] write');
    board.io.pins[pinNumber].mode = pinMode;
    board.io.pinMode(pinNumber, pinMode);
  }

};

/**
 * SYSEX_RESPONSE contains functions to be called when we receive a SYSEX message from the arduino.
 * used as a switch object as seen here http://james.padolsey.com/javascript/how-to-avoid-switch-case-syndrome/
 * @private
 */

var SYSEX_RESPONSE = {};



function printFirmwareVersion(){
  var buf = new Buffer([START_SYSEX,QUERY_FIRMWARE, FIRMWARE_VERSION_MAJOR, FIRMWARE_VERSION_MINOR]);
  console.log(buf.length, 'fwv', buf.toString('hex'));
  for (var i = 0; i < FIRMWARE_NAME.length; i++) {
    //console.log('FIRMWARE_NAME.charCodeAt(i)', i, FIRMWARE_NAME.charCodeAt(i));
    buf = Buffer.concat([buf, sendValueAsTwo7bitBytes(FIRMWARE_NAME.charCodeAt(i)) ]);
    // console.log(buf.length, 'fwv', buf.toString('hex'));
  };
  //buf.write(new Buffer(END_SYSEX));
  buf = Buffer.concat([buf, new Buffer([END_SYSEX])]);

  console.log(buf.length, 'fwv', buf.toString('hex'));
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

SYSEX_RESPONSE[QUERY_FIRMWARE] = function(board) {

  console.log('SYSEX_RESPONSE[QUERY_FIRMWARE]');
  var buf = new Buffer([REPORT_VERSION, 2, 3]);
  buf = Buffer.concat([buf, printFirmwareVersion()]);
  console.log('buf', buf);
  board.sp.write(buf);
};



SYSEX_RESPONSE[CAPABILITY_QUERY] = function(board){

  function writeCapabilites(){
    var output = [START_SYSEX,CAPABILITY_RESPONSE];
    //console.log('SYSEX_RESPONSE[CAPABILITY_QUERY]', board.io.pins.length);
    for (var i = 0; i < board.io.pins.length; i++) {
      var pin = board.io.pins[i];
      //console.log(i, JSON.stringify(pin));
      if (_.contains(pin.supportedModes, MODES.OUTPUT)) {
        output.push(MODES.INPUT);
        output.push(1);
        output.push(MODES.OUTPUT);
        output.push(1);
      }
      if (_.contains(pin.supportedModes, MODES.ANALOG)) {
        output.push(MODES.ANALOG);
        output.push(10);
      }
      if (_.contains(pin.supportedModes, MODES.PWM)) {
        output.push(MODES.PWM);
        output.push(8);
      }
      if (_.contains(pin.supportedModes, MODES.SERVO)) {
        output.push(MODES.SERVO);
        output.push(14);
      }
      if (_.contains(pin.supportedModes, MODES.I2C)) {
        output.push(MODES.I2C);
        output.push(1);  // to do: determine appropriate value
      }
      output.push(127);
    }
    output.push(END_SYSEX);

    //var output = [START_SYSEX,CAPABILITY_RESPONSE,127,127,0,1,1,1,4,14,127,0,1,1,1,3,8,4,14,127,0,1,1,1,4,14,127,0,1,1,1,3,8,4,14,127,0,1,1,1,3,8,4,14,127,0,1,1,1,4,14,127,0,1,1,1,4,14,127,0,1,1,1,3,8,4,14,127,0,1,1,1,3,8,4,14,127,0,1,1,1,3,8,4,14,127,0,1,1,1,4,14,127,0,1,1,1,4,14,127,0,1,1,1,2,10,127,0,1,1,1,2,10,127,0,1,1,1,2,10,127,0,1,1,1,2,10,127,0,1,1,1,2,10,6,1,127,0,1,1,1,2,10,6,1,127,END_SYSEX];
    board.sp.write(new Buffer(output));
  }

  if(board.io.pins && board.io.pins.length > 0){
    writeCapabilites();
  }else{
    board.io.queryCapabilities(function(err, data){
      //console.log('cap query', err, data, board.io.pins);
      writeCapabilites();
    });
  }
}


SYSEX_RESPONSE[ANALOG_MAPPING_QUERY] = function(board){

  function writeMappings(){
    console.log('SYSEX_RESPONSE[ANALOG_MAPPING_QUERY]');

    var output = [START_SYSEX,ANALOG_MAPPING_RESPONSE];
    for (var i = 0; i < board.io.pins.length; i++) {
      var pin = board.io.pins[i];
      output.push(pin.analogChannel);
    }
    output.push(END_SYSEX);

    board.sp.write(new Buffer(output));
    console.log('ANALOG_MAPPING_QUERY done');
  }

  if(board.io.queryAnalogMapping){
    board.io.queryAnalogMapping(writeMappings);
  }else{
    writeMappings();
  }

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

SYSEX_RESPONSE[PIN_STATE_QUERY] = function (board) {
  console.log('SYSEX_RESPONSE[PIN_STATE_QUERY] not implemented', board.currentBuffer);

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



/**
 * Handles a I2C_REPLY response and emits the "I2C-reply-"+n event where n is the slave address of the I2C device.
 * The event is passed the buffer of data sent from the I2C Device
 * @private
 * @param {Board} board the current arduino board we are working with.
 */

SYSEX_RESPONSE[I2C_REPLY] = function(board) {
  var replyBuffer = [];
  var slaveAddress = (board.currentBuffer[2] & 0x7F) | ((board.currentBuffer[3] & 0x7F) << 7);
  var register = (board.currentBuffer[4] & 0x7F) | ((board.currentBuffer[5] & 0x7F) << 7);
  for (var i = 6, length = board.currentBuffer.length - 1; i < length; i += 2) {
    replyBuffer.push(board.currentBuffer[i] | (board.currentBuffer[i + 1] << 7));
  }
  board.emit("I2C-reply-" + slaveAddress, replyBuffer);
};

SYSEX_RESPONSE[ONEWIRE_DATA] = function(board) {
  var subCommand = board.currentBuffer[2];

  if (!SYSEX_RESPONSE[subCommand]) {
    return;
  }

  SYSEX_RESPONSE[subCommand](board);
};

SYSEX_RESPONSE[ONEWIRE_SEARCH_REPLY] = function(board) {
  var pin = board.currentBuffer[3];
  var replyBuffer = board.currentBuffer.slice(4, board.currentBuffer.length - 1);

  board.emit("1-wire-search-reply-" + pin, OneWireUtils.readDevices(replyBuffer));
};

SYSEX_RESPONSE[ONEWIRE_SEARCH_ALARMS_REPLY] = function(board) {
  var pin = board.currentBuffer[3];
  var replyBuffer = board.currentBuffer.slice(4, board.currentBuffer.length - 1);

  board.emit("1-wire-search-alarms-reply-" + pin, OneWireUtils.readDevices(replyBuffer));
};

SYSEX_RESPONSE[ONEWIRE_READ_REPLY] = function(board) {

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

SYSEX_RESPONSE[STRING_DATA] = function(board) {
  var string = new Buffer(board.currentBuffer.slice(2, -1)).toString("utf8").replace(/\0/g, "");
  board.emit("string", string);
};

/**
 * Response from pulseIn
 */

SYSEX_RESPONSE[PULSE_IN] = function(board) {
  var pin = (board.currentBuffer[2] & 0x7F) | ((board.currentBuffer[3] & 0x7F) << 7);
  var durationBuffer = [
    (board.currentBuffer[4] & 0x7F) | ((board.currentBuffer[5] & 0x7F) << 7), (board.currentBuffer[6] & 0x7F) | ((board.currentBuffer[7] & 0x7F) << 7), (board.currentBuffer[8] & 0x7F) | ((board.currentBuffer[9] & 0x7F) << 7), (board.currentBuffer[10] & 0x7F) | ((board.currentBuffer[11] & 0x7F) << 7)
  ];
  var duration = ((durationBuffer[0] << 24) +
    (durationBuffer[1] << 16) +
    (durationBuffer[2] << 8) +
    (durationBuffer[3]));
  board.emit("pulse-in-" + pin, duration);
};


/**
 * Request for a pulse
 */

SYSEX_RESPONSE[PULSE_OUT] = function(board) {
  //TODO - handle this
};

/**
 * Handles the message from a stepper completing move
 * @param {Board} board
 */

SYSEX_RESPONSE[STEPPER] = function(board) {
  var deviceNum = board.currentBuffer[2];
  board.emit("stepper-done-" + deviceNum, true);
};





function IOClient(options) {
  this.io = options.io;
  this.sp = options.serial;

  this.currentBuffer = [];
  var self = this;


  this.sp.on('data', function(data) {
    var byt, cmd;

    console.log('remote data in', data, data.length);



    for (var i = 0; i < data.length; i++) {
      byt = data[i];

      //console.log('byt', byt);


      // we dont want to push 0 as the first byte on our buffer
      if (self.currentBuffer.length === 0 && byt === 0) {
        continue;
      } else {

        if (i === 0 && _.contains([REPORT_VERSION, SYSTEM_RESET], byt)) {
          console.log('one byte command', new Buffer([byt]));
          try{
            MIDI_RESPONSE[byt](self);
          }catch(err){
            console.log('error running one byte command: ' + new Buffer([byt]), err );
          }
        }
        else{
          self.currentBuffer.push(byt);
          //console.log('self.currentBuffer', new Buffer(self.currentBuffer).toString('hex'));
        }


        // [START_SYSEX, ... END_SYSEX]
        if (self.currentBuffer[0] === START_SYSEX &&
          self.currentBuffer[1] &&
          self.currentBuffer[self.currentBuffer.length - 1] === END_SYSEX) {


          if(SYSEX_RESPONSE[self.currentBuffer[1]]){
            console.log('handling sysex', new Buffer(self.currentBuffer), new Buffer([self.currentBuffer[1], QUERY_FIRMWARE]));
            try{
              SYSEX_RESPONSE[self.currentBuffer[1]](self);
            }catch(exp){
              console.log('error handling sysex', exp);
            }
            console.log('handled');
          }
          else{
            console.log('unhanled sysex', self.currentBuffer)
          }
          self.currentBuffer = [];



        } else if (self.currentBuffer[0] !== START_SYSEX) {
          // Check if data gets out of sync: first byte in buffer
          // must be a valid command if not START_SYSEX
          // Identify command on first byte
          cmd = self.currentBuffer[0] < 240 ? self.currentBuffer[0] & 0xF0 : self.currentBuffer[0];

          // Check if it is not a valid command
          if (cmd !== REPORT_VERSION && cmd !== ANALOG_MESSAGE && cmd !== DIGITAL_MESSAGE) {
            //console.log("OUT OF SYNC - CMD: "+cmd);
            // Clean buffer
            //self.currentBuffer.length = 0;
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

          //console.log('MIDI?', cmd);

          if (MIDI_RESPONSE[cmd]) {
            console.log('MIDI', cmd);
            try{
              MIDI_RESPONSE[cmd](self);
            }
            catch(err){
              console.log('error handling MIDI_RESPONSE', cmd, err);
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

    //console.log('cmd in', cmd, new Buffer(self.currentBuffer).toString('hex'));

  }.bind(this));



}

util.inherits(IOClient, EventEmitter);

module.exports = IOClient;
