/*	
	Last update: August 22 2016
	Author: Arthur McCay
______________________________________________________________________________________________________________

	Description
	- This application sends notifications about missed phone calls to a tellegram chat.
	Here's the algorithm:

	1.	Get request sent by a simple php script from Askozia automatic telephone system
		The request has the following form: http://ip:port/missed/phone_number/waiting_time;
	2.	Send message to a telegram chat with inline keyboard containing operator internal numbers +
		customer phone number;
	3.	Once inline keyboard is clicked a callback querry is sent to the bot. Read about callback querries at:
		https://core.telegram.org/bots/api#callbackquery
	4.	Catch the callback querry, make a notification about dialing both by floating window and edited text
		in message, call dial function and store numbers and all id's that identify the telegram message 
		associated with this call in a map;
	5. 	Make a call and proccess events such as when contact picked up or hung up the phone, edit the message
		respectively
______________________________________________________________________________________________________________

*/

//	********************************************** Dependencies **********************************************

var config = require('./config');
// Express variables
var express = require('express');
var app = express();
// Telegram variables
var TelegramBot = require('node-telegram-bot-api');
var bot = new TelegramBot(config.token, {
	polling: true
});
// Asterisk Manager variables
var ami = new require('asterisk-manager')(
	config.agi_port,
	config.agi_host,
	config.ami_login,
	config.ami_pass,
	true
);
ami.keepConnected();

var chatid = config.testchatid;

var currentCalls = new Map();

console.log("_________________________________________________________________________________________________________________________");
console.log("");
console.log("                                                	APP HAS BEEN STARTED                                                ");

//	********************************************** Express **********************************************

/*	Receive get-request containing a phone number sent by Askozia.
	Send message to telegram chat informing the operator about missed call and
	the number also allowing her to choose which intertal number to use to call back. */
app.get('/missed/:phone/:dura', function(req, res) {
	// Extracting and formatting number to dial
    var missedCall = req.params.phone;  
    var phoneNumber = missedCall.replace('+',"").replace('+',"");
    var duration = req.params.dura;

	var replyText = 'Missed call from +' + phoneNumber + '. Waiting time: ' + duration + ' seconds.';
	// Build a custom inline keyboard with internal telephone extentions		
	var options = {
  		reply_markup: JSON.stringify({
   			inline_keyboard: [
  				[
  					{text:'101',callback_data:'101,'+phoneNumber},
  					{text:'202',callback_data:'202,'+phoneNumber},
  					{text:'301',callback_data:'301,'+phoneNumber},
  					{text:'302',callback_data:'302,'+phoneNumber}
  				],
  				[
  					{text:'401',callback_data:'401,'+phoneNumber},
  					{text:'402',callback_data:'402,'+phoneNumber},
  					{text:'501',callback_data:'501,'+phoneNumber},
  					{text:'502',callback_data:'502,'+phoneNumber}
  				]
			]
  		})
	}
	// Send a message with inline buttons to the chat
	bot.sendMessage(chatid, replyText, options);
	res.status("result").send("Request proccessed successfully");
});

app.listen(config.app_port, function () {
  console.log('                                                ATS loaded from ' + config.app_port + ' port.');
  console.log("_________________________________________________________________________________________________________________________");
});

/*	********************************************** Telegram **********************************************

	Respond to callback querry from the previous message */
bot.on('callback_query', function (msg) {
	// Extract internal number from JSON
	var ext = msg.data;
	var arr = ext.split(",");
	var customerNum = arr[1];
	var operatorNum = arr[0];

	// Create different message options
	var message = msg.message.text
	var midMsg = message + "\n🔒" + operatorNum + " dialing " + customerNum + '...';

	/*  After a handful of attempts to make the inline keyboard stay after changing the message text
		inserting json object with keyboard in it appeared to be a fine workaround. */
	var idKboard = {message_id: msg.message.message_id, chat_id: msg.message.chat.id, reply_markup: JSON.stringify({
   			inline_keyboard: [
  				[
  					{text:'101',callback_data:'101,'+customerNum},
  				 	{text:'202',callback_data:'202,'+customerNum},
  				 	{text:'301',callback_data:'301,'+customerNum},
  				 	{text:'302',callback_data:'302,'+customerNum}
  				],
  				[
  					{text:'401',callback_data:'401,'+customerNum},
  					{text:'402',callback_data:'402,'+customerNum},
  					{text:'501',callback_data:'501,'+customerNum},
  					{text:'502',callback_data:'502,'+customerNum}]
			]
  		}),
		message_text: msg.message.text
	};

	var ids = {message_id: msg.message.message_id, chat_id: msg.message.chat.id};
	// Notify about call start
	bot.answerCallbackQuery(msg.id, 'Dialing +' + customerNum + '...',false);
	// Change the message text to assure the operator that ths number has been called
	bot.editMessageText(midMsg, idKboard);

	// Call Asterisk manager method that will initiate dialing
	dial(customerNum, operatorNum, editMessageText, message, idKboard);

	// Create a key for key in map for further identification of calls
	var key = customerNum + "," + operatorNum;
	// Store customer and operator numbers and json object with Id's and keyboard in a map
	currentCalls.set(key, idKboard);
});

/*	********************************************** Asterisk **********************************************

	Initiating a phone call. It first calls the operator and once she accepted the call it dials the customer.

	Full list of Asterisk actions may be found at:
	https://wiki.asterisk.org/wiki/display/AST/Asterisk+11+AMI+Actions */
function dial(num, exten, editMessageText, message, array) {
	ami.action({
  			'action': 'originate',
  			'channel':  'SIP/' + exten,
  			'context': config.local_context + "",
  			'CallerId': 'Alfa',
  			'timeout': '10000',
  			'exten': num,
  			'priority': '1'
		}, function(err_ami, res_ami) {
			// Operator dropped the call, edit message, show inline keyboard
			if (res_ami.response === "Fail") { 
				editMessageText('drop', message, num, exten, array);
			}
		});
}

// Triggers when phone is picked up by customer
ami.on('bridge', function(evt) {
	// Look for map data to match the call metadata
	currentCalls.forEach(function(value, key) {
		var arr = key.split(",");
		var exten = arr[1], num = arr[0];
		// Match number + exten and make sure bridge state is Link, not Unlink
		if (evt.callerid1 === exten && evt.callerid2 === num && evt.bridgestate === 'Link') {
			// delete keyboard to hide it during call to avoid collision
			delete value.reply_markup;			
			editMessageText('success', value.message_text, num, exten, value);
		}
	}, currentCalls);
});

// Triggers when call is ended or dropped
ami.on('hangup', function(evt) {
	// Look for map data to match the call metadata
	currentCalls.forEach(function(value, key) {
		var arr = key.split(",");
		var exten = arr[1], num = arr[0];
		// Match number + exten
		if (evt.connectedlinenum === exten && evt.calleridnum === num) {
		/*  Edit message text and pass hangup cause code.
			Full list of codes can be found at: 
			https://wiki.asterisk.org/wiki/display/AST/Hangup+Cause+Mappings */
			editMessageText(evt.cause, value.message_text, num, exten, value);
			// Delete this pair from the map so it won't call editMessageText twice (hangup event occurs several times)
			currentCalls.delete(key);
		}
	}, currentCalls);
});

// Callback function that changes message upon call result
function editMessageText(cause, message, num, exten, array) {
	// TODO: add case when phone is unavailible or turned off

	// Change the message text to assure the operator that ths number has been called
	var result = "";
	switch (cause) {
		// Customer picked up the phone // 16 - normal clearing
		case 'success':
			result = message + "\n📞 " + exten + " reached +" + num; 
			break;
		// Customer dropped the call
		case '17':
			result = message + "\n📴 +" + num + " dropped call from " + exten;
			break;
		// Customer didn't answer the call
		case '21':
			result = message + "\n🚫 +" + num + " didn't answer the call from " + exten;
			break;
		// Operator dropped the call before reaching customer
		case 'drop':
			result = message + "\n❌ " + exten + " dropped the call to +" + num;
			break;
		case '16':
			result = message + "\n✅ " + exten + " successfully called " + num;
			break;
		default:
			result = message;
			break;
	}
	bot.editMessageText(result, array);
}