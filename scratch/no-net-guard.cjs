/**
 * 「一联网就炸」守卫：挂到进程里（NODE_OPTIONS --require 或直接 require），把出站通道全部换成抛错。
 * 用在离线取证脚本里 —— 这样「这一趟一个请求都没发」不是我的断言，而是进程自己会炸的实测。
 */
const net = require("net");
const http = require("http");
const https = require("https");
const dns = require("dns");

const blowUp = (what) => () => {
  throw new Error(`离线取证里出现了出站调用：${what}`);
};
http.request = blowUp("http.request");
http.get = blowUp("http.get");
https.request = blowUp("https.request");
https.get = blowUp("https.get");
net.Socket.prototype.connect = blowUp("net.Socket.connect");
dns.lookup = () => { throw new Error("离线取证里出现了出站调用：dns.lookup"); };
if (typeof globalThis.fetch === "function") globalThis.fetch = blowUp("fetch");
