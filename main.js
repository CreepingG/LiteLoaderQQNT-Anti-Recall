const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

// const { Level } = require("level");
// var db = null;

function onLoad(plugin) {
    //     db = new Level(path.join(plugin.path.data, "qq-recalled-db"), {
    //         valueEncoding: "json"
    //     });
}

var msgFlow = [];
var recalledMsg = [];

const MAX_MSG_SAVED_LIMIT = 1000;
const DELETE_MSG_COUNT_PER_TIME = 50;

function request(url) {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith("https") ? https : http;
        const req = protocol.get(url);
        req.on("error", (error) => reject(error));
        req.on("response", (res) => {
            // 发生跳转就继续请求
            if (res.statusCode >= 300 && res.statusCode <= 399) {
                return resolve(request(res.headers.location));
            }
            const chunks = [];
            res.on("error", (error) => reject(error));
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => resolve(Buffer.concat(chunks)));
        });
    });
}

async function downloadPic(msgList) {
    if (msgList == null) return;

    for (item of msgList.elements) {
        if (item.picElement) {
            var pic = item.picElement;
            var picBasePath = pic.md5HexStr.toUpperCase();
            var urlBase = `https://gchat.qpic.cn/gchatpic_new/0/0-0-${picBasePath}/`;

            output(
                `[${pic.md5HexStr
                    .toUpperCase()
                    .substring(0, 5)}]Downloading lost pic(s)... ${urlBase}`
            );

            if (!fs.existsSync(pic.sourcePath)) {
                const body = await request(`${urlBase}0`);
                fs.mkdirSync(path.dirname(pic.sourcePath), { recursive: true });
                fs.writeFileSync(pic.sourcePath, body);
            } else {
                output(
                    `[${pic.md5HexStr
                        .toUpperCase()
                        .substring(0, 5)}]Pic(s) already existed, skip.`
                );
            }

            if (pic.thumbPath instanceof Array) {
                pic.thumbPath.forEach(async (value, key) => {
                    if (!fs.existsSync(value)) {
                        const body = await request(`${urlBase}${key}`);
                        fs.mkdirSync(path.dirname(value), { recursive: true });
                        fs.writeFileSync(value, body);
                    }
                });
            }
            output(
                `[${pic.md5HexStr
                    .toUpperCase()
                    .substring(0, 5)}]Download completed!`
            );
        }
    }
}

function onBrowserWindowCreated(window) {
    window.webContents.on("did-stop-loading", () => {
        //只针对主界面和独立聊天界面生效
        if (
            window.webContents.getURL().indexOf("#/main/message") != -1 ||
            window.webContents.getURL().indexOf("#/chat/") != -1
        ) {
            //补充知识：
            //撤回的原理是，你先发了一条消息，这条消息有一个msgId，然后又撤回了他，那腾讯就会发一条一样msgId的撤回消息包来替换，这样你以后拉取的话，这个msgId只会对应一条撤回提示了；
            //本插件的原理是，先在内存中临时储存所有消息（1000条上限），然后如果有撤回发生，则将撤回的提示替换为之前保存的消息。

            const original_send =
                (window.webContents.__qqntim_original_object &&
                    window.webContents.__qqntim_original_object.send) ||
                window.webContents.send;

            //var myUid = "";
            const patched_send = function (channel, ...args) {
                // if (db != null) {
                //     db.put("a", { x: 123 }, function (err) {
                //         if (err) throw err;

                //         db.get("a", function (err, value) {
                //             console.log(value); // { x: 123 }
                //         });
                //     });
                // }

                try {
                    if (args.length >= 2) {
                        //MessageList IPC 中能看到消息全量更新内容，其中包含撤回的提示，但并不包含被撤回的消息（被撤回的已经被替换掉了），需要替换撤回提示为之前保存的消息内容
                        if (
                            args.some(
                                (item) =>
                                    item &&
                                    item.hasOwnProperty("msgList") &&
                                    item.msgList != null &&
                                    item.msgList instanceof Array &&
                                    item.msgList.length > 0
                            )
                        ) {
                            //撤回提示所在的msgList下标数组，在后面需要一个个替换为真实的消息
                            var needUpdateIdx = [];
                            for (let idx in args[1].msgList) {
                                var item = args[1].msgList[idx];
                                if (item.msgType == 5 && item.subMsgType == 4) {
                                    if (
                                        item.elements[0].grayTipElement !=
                                            null &&
                                        item.elements[0].grayTipElement
                                            .revokeElement != null &&
                                        !item.elements[0].grayTipElement
                                            .revokeElement.isSelfOperate
                                    ) {
                                        needUpdateIdx.push(idx);
                                    }
                                }
                                // console.log(
                                //     item.recallTime,
                                //     "<====>",
                                //     item.elements,
                                //     "<====>",
                                //     item.elements[0].grayTipElement.revokeElement
                                // );
                            }

                            needUpdateIdx.sort((a, b) => b - a);

                            needUpdateIdx.forEach((i) => {
                                var currMsgId = args[1].msgList[i].msgId;

                                //如果之前存了消息
                                var olderMsg = msgFlow.find(
                                    (i) => i.id == currMsgId
                                );
                                var olderMsgFromRecalledMsg = recalledMsg.find(
                                    (i) => i.id == currMsgId
                                );

                                //优先从已保存的撤回的消息中获取
                                if (olderMsgFromRecalledMsg != null) {
                                    downloadPic(olderMsgFromRecalledMsg.msg);

                                    args[1].msgList[i] =
                                        olderMsgFromRecalledMsg.msg;

                                    output(
                                        "Detected recall, intercepted and recovered from old msg"
                                    );
                                }
                                //如果没有存过，则说明他在消息流里
                                else if (olderMsg != null) {
                                    args[1].msgList[i] = olderMsg.msg;

                                    //没专门存过这条消息到专门的反撤回数组中，就存一下
                                    if (olderMsgFromRecalledMsg == null) {
                                        recalledMsg.push(olderMsg);
                                    }

                                    downloadPic(olderMsg.msg);

                                    output(
                                        "Detected recall, intercepted and recovered from msgFlow"
                                    );
                                }
                            });

                            window.webContents.send(
                                "LiteLoader.anti_recall.mainWindow.recallTipList",
                                recalledMsg.map((i) => i.id)
                            );
                        }

                        //增量更新 IPC
                        if (
                            args.some(
                                (item) =>
                                    item instanceof Array &&
                                    item.length > 0 &&
                                    item[0] &&
                                    item[0].cmdName != null
                            )
                        ) {
                            var args1 = args[1][0];
                            if (args1 == null) return;

                            //方法一：获取个人信息的IPC，用来获取个人UID，避免防撤回自己的消息
                            // if (args1.cmdName.indexOf("onProfileDetailInfoChanged") != -1) {
                            //     myUid = args1.payload.info.uid;
                            // } else
                            //目前采用方法二，直接获取撤回消息中的参数
                            //拦截撤回IPC
                            if (
                                args1.cmdName != null &&
                                args1.cmdName.indexOf("onMsgInfoListUpdate") !=
                                    -1 &&
                                args1.payload != null &&
                                args1.payload.msgList instanceof Array
                            ) {
                                var msgList = args1.payload.msgList[0];

                                if (
                                    msgList.msgType == 5 &&
                                    msgList.subMsgType == 4
                                ) {
                                    //不是自己撤回的，才拦截
                                    if (
                                        msgList.elements[0].grayTipElement !=
                                            null &&
                                        msgList.elements[0].grayTipElement
                                            .revokeElement != null &&
                                        !msgList.elements[0].grayTipElement
                                            .revokeElement.isSelfOperate
                                    ) {
                                        window.webContents.send(
                                            "LiteLoader.anti_recall.mainWindow.recallTip",
                                            msgList.msgId
                                        );

                                        //如果之前存了消息
                                        var olderMsg = msgFlow.find(
                                            (i) => i.id == msgList.msgId
                                        );
                                        var olderMsgFromRecalledMsg =
                                            recalledMsg.find(
                                                (i) => i.id == msgList.msgId
                                            );

                                        //之前存了消息，但是还没有存入专门的反撤回数组中
                                        if (
                                            olderMsg != null &&
                                            olderMsgFromRecalledMsg == null
                                        ) {
                                            recalledMsg.push(olderMsg);
                                        }

                                        downloadPic(olderMsg?.msg);
                                        downloadPic(
                                            olderMsgFromRecalledMsg?.msg
                                        );

                                        args[1][0].cmdName = "none";
                                        args[1][0].payload.msgList.pop();

                                        // console.log(args1.payload);
                                        output("Detected recall, intercepted");
                                    }
                                }
                            }
                            //接到消息
                            else if (
                                args1.cmdName != null &&
                                args1.cmdName.indexOf("onRecvMsg") != -1 &&
                                args1.payload != null &&
                                args1.payload.msgList instanceof Array
                            ) {
                                var msgList = args1.payload.msgList;

                                for (msg of msgList) {
                                    var msgId = msg.msgId;

                                    msgFlow.push({ id: msgId, msg: msg });
                                    if (msgFlow.length > MAX_MSG_SAVED_LIMIT) {
                                        msgFlow.splice(
                                            0,
                                            DELETE_MSG_COUNT_PER_TIME
                                        );
                                    }
                                }
                            }
                        }
                    }
                } catch (e) {
                    output(
                        "NTQQ Anti-Recall Error: ",
                        e,
                        "Please report this to https://github.com/xh321/LiteLoaderQQNT-Anti-Recall/issues, thank you"
                    );
                }
                return original_send.call(window.webContents, channel, ...args);
            };
            if (window.webContents.__qqntim_original_object)
                window.webContents.__qqntim_original_object.send = patched_send;
            else window.webContents.send = patched_send;

            output(
                "NTQQ Anti-Recall loaded for window: " +
                    window.webContents.getURL()
            );
        }
    });
}

function output(...args) {
    console.log("\x1b[32m%s\x1b[0m", "Anti-Recall:", ...args);
}

module.exports = {
    onLoad,
    onBrowserWindowCreated
};
