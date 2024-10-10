const express = require("express");
const mongoose = require("mongoose");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs")
const jwt = require("jsonwebtoken");
const cors = require("cors");
const ws = require("ws");
const fs = require("fs"); //fs是Node.js 內建模組，用於處理文件交互行為
const UserModel = require("./Models/User");
const MessageModel = require("./Models/Message");
const { stringify } = require("querystring");
require('dotenv').config();

const app = express();
const SECRET_KEY = process.env.JWT_SECRET_KEY;

mongoose.connect(process.env.MONGO_URL)
    .then(() => console.log("MongoDB connected"))
    .catch(err => console.error("MongoDB connection error:", err));

app.use("/uploads", express.static(__dirname + "/uploads"));
app.use(express.json());
app.use(cookieParser());
app.use(cors({
    credentials: true,
    origin: true,
}));

//處理token解析
//1.為何使用async?:方便後續調用函式時使用await取代then的龐雜寫法來獲取promise返回值
//2.為何定義getUserDataFromRequest為函式而非變數?:這樣才能根據調用的環境動態捕捉req，寫成變數，則req在第一次被伺服器捕獲後，就固定了
async function getUserDataFromRequest(req) {
    return new Promise((resolve, reject) => {
        const token = req.cookies?.token;      //由於註冊時對於cookie的定義，當前端發出req的時候，這個cookie會被自動包入傳送項目，所以能夠在此調用。
        if (token) {
            jwt.verify(token, SECRET_KEY, {}, (err, userData) => {
                if (err) throw err;
                resolve(userData);
            });
        }
        else {
            reject("no token");
        }
    });

};


// app.get("/test", (req, res) => {
//     res.json("test ok");
// });

//處理解析前端的GET profile請求，根據token內容解析出iD、username
app.get("/profile", (req, res) => {
    const token = req.cookies?.token;
    if (token) {
        jwt.verify(token, SECRET_KEY, {}, (err, userData) => {
            if (err) throw err;
            res.json(userData);
        });
    }
    else {
        res.status(401).json("no token")
    };
});

//處理向MongoDB獲取歷史聊天訊息
app.get("/messages/:userId", async (req, res) => {
    try {
        const { userId } = req.params; //聊天對象Id
        if (userId === "none") return;
        const userData = await getUserDataFromRequest(req);
        const ourUserId = userData.userId;  //當前用戶端用戶Id

        await MessageModel.updateMany(
            {
                sender: userId,
                recipient: ourUserId,
                readByRecipient: false,
            },
            { $set: { readByRecipient: true } });


        const messages = await MessageModel.find({
            sender: { $in: [userId, ourUserId] }, //$in: 運算子，MongoDB特有查詢運算子，用於查詢給定值是否存在於MongoDB Collection內的資料中(此為: Message collection中的sender是否存在特定值)
            recipient: { $in: [userId, ourUserId] },
        }).sort({ createdAt: 1 })    //sort(): 使查詢結果依據特定順序排列； {createdAt: 1}: 表示升序排列(舊-->新)，此順序方便後續從聊天室渲染的紀錄也是由舊到新
        res.json(messages);

        const targetClient = [...wss.clients].find(client => client.userId === String(userId));
        if (targetClient) {
            targetClient.send(JSON.stringify({
                type: "all-read"
            }));
        }
        
    }
    catch (err) {
        if (err) throw err;
        res.status(500).json({ message: "Internal server error" });
    };
});


//處理獲取所有用戶資訊(包含在線、離線)
app.get("/people", async (req, res) => {
    const users = await UserModel.find({}, { "_id": 1, "username": 1 });  //第一參數:{}表示回傳所有資料;第二參數:進一步，指定回傳的資料為每筆資料的"_id"、"username"，1 === true。
    res.json(users);
});



//處理註冊
app.post("/register", async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ message: "Username and password are required" });
    }

    try {
        const existingUser = await UserModel.findOne({ username });
        if (existingUser) {
            return res.status(400).json({ message: "Username already exists" });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = new UserModel({ username, password: hashedPassword });

        await newUser.save();

        const token = jwt.sign({ userId: newUser._id, username }, SECRET_KEY, {});

        // 使用res.cookie取代localStorage提高安全性，並設定sameSite、sevure等控制cookie的行為(定義何種情況下可以被傳送)
        // 在res中除了status、json數據，新增加cookie
        res.cookie('token', token, { sameSite: 'none', secure: true, path: '/', maxAge: 24 * 60 * 60 * 1000 })  //sameSite: 跨站請求發送cookie的控制策略(strict: 完全禁止跨站發送、Lax:只允許特定請求時發送、none:未禁止)
            .status(201)                                                //secure: 只有在HTTPS連接下發送? true: yse/ false: no
            .json({
                id: newUser._id,
                username,
            });


    }
    catch (err) {
        if (err) throw err;
        res.status(500).json({ message: 'Internal server error' });
    };
});



//處理登入
app.post("/login", async (req, res) => {
    const { username, password } = req.body;

    try {
        const foundUser = await UserModel.findOne({ username });
        if (!foundUser) {
            return res.status(400).json({ message: "Invalid username or password" });
        }

        const isPasswordValid = await bcrypt.compare(password, foundUser.password);
        if (!isPasswordValid) {
            return res.status(400).json({ message: "Invalid password" });
        }

        const token = jwt.sign({ userId: foundUser._id, username }, SECRET_KEY, {});
        res.cookie('token', token, { sameSite: 'none', secure: true }).json({
            id: foundUser._id,
        });
    }
    catch (error) {
        res.status(500).json({ message: "Server error" });
    };
})

//處理登出
app.post("/logout", (req, res) => {
    res.cookie('token', "", { sameSite: 'none', secure: true }).json("ok");
})

const PORT = process.env.PORT || 5000;


const server = app.listen(PORT);

const wss = new ws.WebSocketServer({ server }); //建立websoket server

wss.on("connection", (connection, req) => {        //當某處與wss建立連線時，建立一個獨立的connection引數；connect引數其實是個獨立的物件，其代表某次、某處客戶端與伺服器建立的"連線"，而藉由這個連線，可以使用各種方法與此關係的客戶端進行互動。比如:connection.send()會向該連線的客戶端發送訊息
    //向連線到wss的所有用戶端發送訊息:哪些人正在線上
    function notifyAboutOnlinePeople() {
        const onlineUsers = [...wss.clients].map(client => ({ userId: client.userId, username: client.username }))
        .filter(user => user.userId && user.username);
        

        [...wss.clients].forEach(client => {
            client.send(JSON.stringify({
                online: onlineUsers,
            }));
        });
    }

    connection.on("close", () => {
        notifyAboutOnlinePeople(); // 用戶斷開連接時更新在線用戶列表
    });


    //檢測伺服器與用戶端的連線狀態
    connection.isAlive = true;  //標記連接為存活狀態

    connection.timer = setInterval(() => {              //每5秒，這個client端，就會向伺服器發送ping信號。且伺服器若仍與client保持聯繫，則伺服器會自動發出一個pong信號給client端。如果發送ping的1秒後，仍未收到伺服器的pong回應，則終止連線狀態。
        connection.ping();
        connection.deathTimer = setTimeout(() => {
            connection.isAlive = false;
            clearInterval(connection.timer);
            connection.terminate();
            notifyAboutOnlinePeople();  //此函式在此重新調用，因為用戶在線狀態已經更新
            //console.log("dead");
        }, 5000)
    }, 10000);

    connection.on("pong", () => {   //當伺服器嘗試發送pong信號給該connecttion代表的client端時，會觸發deathTimer重新計時，避免終止連線。
        clearTimeout(connection.deathTimer);
    });


    // 在websocket連線中對每個connection附加用戶的身份資訊，以便後續處理能使用這些資訊。
    // 策略: 使用客戶端發送的req，解析toekn資訊，獲取用戶身分
    const cookies = req.headers.cookie;
    if (cookies) {
        const tokenCookieString = cookies.split(";").find(str => str.startsWith("token="));     //使用split():如果傳入的cookies內容為複數，需要先將其一一拆分，再找出其中需要的資訊，此處則找尋token
        if (tokenCookieString) {
            const token = tokenCookieString.split("=")[1];
            if (token) {
                jwt.verify(token, SECRET_KEY, {}, (err, userData) => {
                    if (err) throw err;
                    const { userId, username } = userData;
                    connection.userId = userId;
                    connection.username = username;

                });
            };
        };
    };


    //處理用戶端發送來的訊息
    connection.on("message", async (message) => {
        
        const messageData = JSON.parse(message);

        console.log(messageData);
        
        const { recipient, text, file, _id } = messageData;

        let filename = null;
        if (file) {        
            filename = file.name;
            const path = __dirname + "/uploads/" + filename;
            const bufferData = new Buffer(file.data.split(",")[1], "base64");
            fs.writeFile(path, bufferData, () => {
                console.log("file saved:" + path);
            })
        }
        if (recipient && (text || file)) {
            //在MessageModel中建立實體訊息資料
            const messageDoc = await MessageModel.create({
                sender: connection.userId,
                recipient,
                text,
                file: file ? { name: filename } : null,
                readByRecipient: false,
                sendTime: _id,
            });

            console.log("created message");

            //將訊息發送給特定用戶端(聊天對象)
            const recipientClients = [...wss.clients].filter(client => client.userId === recipient)
            recipientClients.forEach(client => client.send(JSON.stringify({
                text,
                sender: connection.userId,
                recipient,
                file: file ? { name: filename } : null,
                _id: messageDoc._id,
                readByRecipient: false,
                sendTime: _id,
            })))  //注意此處的connecttion指向最初與wss建立這個聯繫的用戶端(訊息的發送方)，而不是此處filter過濾出來的用戶端(訊息的接受方)         
        };


        if (messageData.type === "read") {
            // console.log([...wss.clients].map(client => ({
            //     userId: client.userId,
            //     readyState: client.readyState // 檢查 WebSocket 的狀態
            // })));


            // const message_id = messageData.message_id;
            // const recipient = messageData.recipient;
            // const sendTime = messageData.sendTime;
            

            const {message_id, recipient, sender, sendTime} = messageData;
            await MessageModel.updateOne({ _id: message_id }, { $set: { readByRecipient: true } });
            
            const clientsData = [...wss.clients].map(c => ({userId: c.userId, username: c.username, selectedUserId: c.selectedUserId}));
            // console.log(clientsData);
            const clientsNeedToCheckSelectedUSerId = clientsData.filter(client => client.userId === sender);


            // console.log("recipient:",clientsNeedToCheckSelectedUSerId);

            const senderClient = [...wss.clients].filter(client => client.userId === recipient);
            senderClient.forEach(client => {
                
                    client.send(JSON.stringify({
                        type: "read",
                        message_id: messageData.message_id,
                        sendTime: sendTime,
                        yourChatPartnerIsChattingWith: clientsNeedToCheckSelectedUSerId[0].selectedUserId,
                    }));
                
            });
        };


        if (messageData.type === "selected_user_change") {
            connection.selectedUserId = messageData.selectedUserId;
            const clientsData = [...wss.clients].map(c => ({userId: c.userId, username: c.username, selectedUserId: c.selectedUserId}));

            

            // console.log(clientsData);
        }
    });



    notifyAboutOnlinePeople();
});

