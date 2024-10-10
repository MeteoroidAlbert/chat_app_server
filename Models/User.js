const mongoose = require('mongoose');


//定義資料儲存形式、規則
const userSchema = new mongoose.Schema({
    username: {
        type: String,
        required: true,
        unique: true,
    },
    password: {
        type: String,
        required: true,
    }
}, { timestamps: true });  //第二個參數用於追蹤資料更新用


//依據規則建立Model
const UserModel = mongoose.model('User', userSchema);

module.exports = UserModel;