// zwave to mqtt bridge. Works well with Home Assistant
//
// This simple nodejs script exposes zwave devices to an mqtt broker. Each device is configured into a "devices" array
// so that you define each attribute into a separated entity. This means that you can control multiple different
// properties which are in fact in the same zwave device.
//
// Each "device" is exposed into mqtt so that they have two topics: One for setting the state and another for publishing
// the current state: If you set the "topic" to "foo/bar", then this app listens topic "foo/bar/set". The value published
// to this topic will be sent to the zwave network.
//
// When the value has been set then a message is published to "foo/bar/state" where the value is the new state of the device.
//

var process = require('process');
var OZW = require('openzwave-shared');
var MQTT = require('mqtt');

var zwave_device = '/dev/ttyACM0';
var zwave = new OZW({
        SaveConfig : false,
        Logging : true,
        ConsoleOutput : false
});
var client = MQTT.connect('mqtt://172.16.153.4');


// List of devices. This is a bit crude, but working way to list devices. The devices are specified with an array of properties.
// Let me explain:
// - Each device in zwave network has an unique id. (first item in the array, see later for explanation)
// - Within the device there are numerous "classes" of commands (2nd item in the array)
// - Each class can have multiple "instances" (3rd item in the array)
// - Each instance can have multiple values, which are "indexes". (4th item in the array)
//
// This is a bit complicated. For example my Fibaro Double Relay Switch has an id 2 in the network.
// The switch supports COMMAND_CLASS_SWITCH_BINARY (number 37) to switch the two different relays on and off.
// Then the two relays are in instances 2 and 3 (no idea why not just 0 and 1.) The index is always 0.
//
// So in order to command this you need to pack these numbers into an array, eg: [2, 37, 2, 0]
//
// You can see the zwave config xml (node_modules/openzwave-shared/zwcfg_0xf7b04fae.xml or similar file)
// to probe your devices and to get the idea of the commands. You should also look on the zwave device
// manual about supported classes.
// 
// Here's an example of these two devices in the xml:
// <Node id="2" name="" location="" basic="4" generic="16" specific="1" roletype="5" devicetype="1792" nodetype="0" type="Binary Power Switch" listening="true" frequentListening="false" beaming="true" routing="true" max_baud_rate="40000" version="4" query_stage="Complete">
//   <Manufacturer id="10f" name="FIBARO System">
//     <Product type="203" id="1000" name="Unknown: type=0203, id=1000" />
//   </Manufacturer>
//   <CommandClasses>
//   ... bunch of other CommandClass tags
//   <CommandClass id="37" name="COMMAND_CLASS_SWITCH_BINARY" version="1" request_flags="5" innif="true">
//     <Instance index="1" />
//     <Instance index="2" endpoint="1" />  <!-- this is the first relay, at least in my case -->
//     <Instance index="3" endpoint="2" />  <!-- this is the second relay, at leats in my case ->>
//     <Value type="bool" genre="user" instance="1" index="0" label="Switch" units="" read_only="false" write_only="false" verify_changes="false" poll_intensity="0" min="0" max="0" value="False" />
//     <Value type="bool" genre="user" instance="2" index="0" label="Switch" units="" read_only="false" write_only="false" verify_changes="false" poll_intensity="0" min="0" max="0" value="False" />
//     <Value type="bool" genre="user" instance="3" index="0" label="Switch" units="" read_only="false" write_only="false" verify_changes="false" poll_intensity="0" min="0" max="0" value="True" />
//  </CommandClass>

var devices = [
  {
    zwave:[2, 37, 3, 0],
    name: "alavalot",
    topic: "nest/zwave/sauna/alavalot"
  },
  {
    zwave:[2, 37, 2, 0],
    name: "terassivalo",
    topic: "nest/zwave/sauna/terassivalo"
  }
];

// END OF CONFIGURATION STUFF

zwave.on('connected', function() {
  console.log("connected to zwave");
});

zwave.on('node added', function(nodeid) {
  console.log("node added", nodeid);
}); 


var handleValue = function(nodeid, commandclass, value) {
  if (commandclass == 37) {
    console.log("value for node", nodeid, "command class:", commandclass, "value:", value);
  }
  for (var i = 0; i < devices.length; i++) {
    if (nodeid == devices[i].zwave[0] && commandclass == devices[i].zwave[1] && value.instance == devices[i].zwave[2] && value.index == devices[i].zwave[3]) {

      // Some devices send the "latest" value too fast when the value is in fact the previous state
      // Because of this we use the .pending structure to trigger a refreshValue() call 
      // see https://github.com/OpenZWave/node-openzwave-shared/issues/65
      if (devices[i].pending !== undefined && value.value != devices[i].pending.value && devices[i].pending.fired < 6) {
        console.log("Got old value for", devices[i].zwave, "value:", value.value, "when it should be", devices[i].pending.value, "this has been checked for", devices[i].pending.fired, "times.");
        devices[i].fired++;
        var data = devices[i];
        setTimeout(function() {
          zwave.refreshValue(data.zwave[0], data.zwave[1], data.zwave[2], data.zwave[3]);
        }, 400);
      } else {
        console.log("Got device state for", devices[i].name, "state:", value.value);

        // Reset any possible pending structure
        if (devices[i].pending !== undefined) {
          delete devices[i].pending;
        }
        var str = "";
        if (value.type == 'bool') { // Bool values are pubished as ON/OFF strings
          str = value.value ? "ON" : "OFF";
        } else {
          str = value.value;
        }
        client.publish(devices[i].topic + "/state", value.value ? "ON" : "OFF", {retain: true});
      }
    }
  }
};

zwave.on('value changed', handleValue);
zwave.on('value added', handleValue);

zwave.on('scan complete', function() {
  console.log("scan complete");
});

var stopping = false;
process.on('SIGINT', function() {
  console.log("stopping...");
  if (!stopping) {
    client.end();
    console.log("mqtt stopped");
    zwave.disconnect(zwave_device);
    console.log("zwave stopped");
    setTimeout(function() {
      console.log("Exiting now!");
      process.exit();
    }, 1000);
  } else {
    process.exit();
  }
  stopping = true;
});

client.on('connect', function () {
  console.log("Connected to mqtt");
  client.subscribe('nest/zwave/sauna/#');
  zwave.connect(zwave_device);
});

client.on('message', function (topic, message) {
  var str = message.toString();
  for (var i = 0; i < devices.length; i++) {
    if (topic == devices[i].topic + "/set") {
    
      var state = 0;
      if (str == "ON") {
        state = 1;
      } else if (str == "OFF") {
        state = 0;
      } else if (!isNaN(parseInt(str))) {
        state = parseInt(str);
      } else {
        state = str;
      }
      console.log("Setting light", devices[i].name, "to", str);
      zwave.setValue(devices[i].zwave[0], devices[i].zwave[1], devices[i].zwave[2], devices[i].zwave[3], state);

      // Stored the expected value so that we can check later that we got the expected value of of the zwave network
      devices[i].pending = { value: state, fired:0 };

      //client.publish(devices[i].topic + "/state", str, {retain:true});
    }
  }

})

