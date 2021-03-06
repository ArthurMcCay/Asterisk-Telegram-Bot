/**
  Last update: Oct 21 2016 at 1:35 PM
  Author: Arthur McCay
______________________________________________________________________________________________________________

  Description
  - This application sends notifications about missed phone calls to a
  tellegram chat.
  Here's the algorithm:

  1.	Get request sent by a simple php script from Askozia automatic
      telephone system. The request has the following form:
      http://ip:port/missed/phone_number/waiting_time;
  2.	Send message to a telegram chat with inline keyboard
      containing operator internal numbers + customer phone number;
  3.	Once inline keyboard is clicked a callback querry is sent to the bot.
      Read about callback querries at:
      https://core.telegram.org/bots/api#callbackquery
  4.	Catch the callback querry, make a notification about dialing
      both by floating window and edited text in message,
      call dial function and store numbers and all id's that
      identify the telegram message associated with this call in a map;
  5. 	Make a call and proccess events such as when contact picked up or
      hung up the phone, edit the message respectively.
______________________________________________________________________________________________________________ */

var config = require('./config.js');
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

var utilities = require("./utilities/utilities.js");
var kbCreator = require("./utilities/keyboard.js");

var currentCalls = new Map();

  //Receive get-request containing a phone number sent by Askozia.
  // Send message to telegram chat informing the operator about missed call and
  // the number also allowing her to choose which intertal number to use to call back.
app.get('/missed/:phone/:dura', function(req, res) {
  // Extracting and formatting number to dial
  var missedCall = req.params.phone;
  var phoneNumber = missedCall.replace('+','').replace('+','');
  var duration = req.params.dura;

  var replyText = 'Missed call from: ' +
                  phoneNumber +
                  '. Waiting time: ' +
                  duration +
                  ' seconds.';

  // Build a custom inline keyboard with internal telephone extentions
  var keyboard = {reply_markup: JSON.parse(kbCreator.createInlineKeyboard(false))};

  // Send a message with inline buttons to the chat
  bot.sendMessage(config.chatid, replyText, keyboard);

  res.status('result').send('Request proccessed successfully');
});

app.listen(config.app_port, function () {
  console.log('ATS loaded from ' + config.app_port + ' port.');
});

// Respond to callback querry from the previous message
bot.on('callback_query', function (msg) {
  var messageText = msg.message.text;
  var regexArray = messageText.match(/7\d{10}/);
  var customerNum = regexArray[0];
  // Extract internal number from JSON
  var operatorNum = msg.data;

  if (msg.data === 'show') {
    var keyboard = kbCreator.createInlineKeyboard(false);
    var idKBoard = {message_id: msg.message.message_id,
                    chat_id: msg.message.chat.id,
                    reply_markup: JSON.parse(keyboard),
                    message_text: msg.message.text};
    bot.editMessageText(msg.message.text + ' ', idKBoard);
  } else {
    // Create different message options
    var message = msg.message.text
    var midMsg = message +
                 '\n🔒' +
                 operatorNum +
                 ' dialing ' +
                 customerNum +
                 '...';

    // Build a custom inline keyboard with internal telephone extentions
    var keyboard = kbCreator.createInlineKeyboard(false);

		//  After a handful of attempts to make the inline keyboard stay
    // after changing the message text inserting json
		//  object with keyboard in it appeared to be a fine workaround.
    var idKBoard = {message_id: msg.message.message_id,
                    chat_id: msg.message.chat.id,
                    reply_markup: JSON.parse(keyboard),
                    message_text: msg.message.text};

    var ids = {message_id: msg.message.message_id,
               chat_id: msg.message.chat.id};

    // Notify about call start (floating notification)
    bot.answerCallbackQuery(msg.id, 'Dialing +' + customerNum + '...',false);

    // Change the message text and hide keyboard
    // for the calling time to avoid collisons
    midMsg = utilities.trimMessage(midMsg);
    bot.editMessageText(midMsg, ids);

    // Call Asterisk manager method that will initiate dialing
    dial(customerNum, operatorNum, editMessageText, message, idKBoard);

    // Create a key for key in map for further identification of calls
    var key = customerNum + ',' + operatorNum;
    // Store customer and operator numbers and json object
    // with Id's and keyboard in a map
    currentCalls.set(key, idKBoard);
  }
});

// Initiating a phone call. It first calls the operator and once she
// accepted the call 4it dials the customer.

// Full list of Asterisk actions may be found at:
// https://wiki.asterisk.org/wiki/display/AST/Asterisk+11+AMI+Actions
function dial(num, exten, editMessageText, message, array) {
  ami.action({
        'action': 'originate',
        'channel':  'SIP/' + exten,
        'context': config.local_context + '',
        'CallerId': 'Alfa',
        'timeout': '10000',
        'exten': num,
        'priority': '1'
  }, function(err_ami, res_ami) {
			// Operator dropped the call, edit message, show inline keyboard
     if (res_ami.response === 'Fail' || res_ami.response === 'Error') {
        editMessageText('drop', message, num, exten, array);
     }
  });
}

//	Asterisk events proccessing

//	Full list of Asterisk events is availible at:
//	https://wiki.asterisk.org/wiki/display/AST/Asterisk+11+AMI+Events

// Triggers when phone is picked up by customer
ami.on('bridge', function(evt) {
  var key = evt.callerid2 + ',' + evt.callerid1;
  var jsonObject = currentCalls.get(key);
	// Match number + exten and make sure bridge state is Link, not Unlink
  if (currentCalls.get(key) !== undefined && evt.bridgestate === 'Link') {
    // Delete keyboard to hide it during call to avoid collision
    delete jsonObject.reply_markup;
    editMessageText('success',
                    jsonObject.message_text,
                    evt.callerid2,
                    evt.callerid1,
                    jsonObject);
  }
});

// Triggers when call is ended or dropped
ami.on('hangup', function(evt) {
  var key = evt.calleridnum + ',' + evt.connectedlinenum;
  var jsonObject = currentCalls.get(key);
  // Check if the unique number + exten key is present in the map
  if (currentCalls.get(key) !== undefined) {
    // Append keyboard back
    if (evt.cause === '16') {
      var keyboard = kbCreator.createInlineKeyboard(true);
    } else {
      var keyboard = kbCreator.createInlineKeyboard(false);
    }

    jsonObject.reply_markup = JSON.parse(keyboard);

    // Edit message text and pass hangup cause code.
    // Full list of codes can be found at:
    // https://wiki.asterisk.org/wiki/display/AST/Hangup+Cause+Mappings
    editMessageText(evt.cause,
                    jsonObject.message_text,
                    evt.calleridnum,
                    evt.connectedlinenum,
                    jsonObject);
    // Delete this pair from the map so it won't call editMessageText twice (hangup event occurs several times)
    currentCalls.delete(key);
  }
});

// Callback function that changes message upon call result
function editMessageText(cause, message, num, exten, array) {
  message = utilities.trimMessage(message);
  // Change the message text to assure the operator
  // that ths number has been called
  var result = '';
  switch (cause) {
    // Customer picked up the phone // 16 - normal clearing
    case 'success':
      result = message +
               '\n📞 '+
               exten +
               ' reached +' +
               num;
      break;
    // Operator dropped the call before reaching customer
    case 'drop':
      result = message +
               '\n❌ ' +
               exten   +
               'dropped the call to +' +
               num;
      break;
   // Customer dropped the call
    case '17':
      result = message +
               '\n📴 +' +
               num +
               ' dropped call from ' +
               exten;
      break;
    // Customer didn't answer the call
    case '21':
      result = message +
               '\n🚫 +' +
               num +
               ' didn\'t answer the call from ' +
               exten;
      break;
    case '16':
      result = message +
               '\n✅ ' +
               exten +
               ' successfully called ' +
               num;
      break;
    default:
      result = message;
      break;
  }
  bot.editMessageText(result, array);
}
