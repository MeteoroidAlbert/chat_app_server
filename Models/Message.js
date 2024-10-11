const mongoose = require("mongoose");

const MessageSchema = new mongoose.Schema({
    sender: {
        type: mongoose.Schema.Types.ObjectId,  //指sender這個資料的資料類型是ObjectId；前綴mongoose.Schema.Types表示該ObjectId為Momgose資料類型，實際上ObjectId就是MongoDB中的_id字段
        ref: "User",                            //指這個ObjectId來自User collection，目的:將Message collection與User collection連結
    },
    recipient: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
    },
    text: String,
    file: {
        name: String,
        url: String,
    },
    createdAt: {type: Date, default: Date.now},
    readByRecipient: {type: Boolean, default: false},
    sendTime: String
}, {timestamps: true});


const MessageModel = mongoose.model("Message", MessageSchema);

module.exports = MessageModel;