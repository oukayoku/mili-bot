# 陪伴助手·米粒

一个可以加为 LINE 好友、也可以拉进群聊的陪伴机器人。默认人设是"米粒"——一只已经离开的心爱比熊,以聊天机器人的形式继续温暖地陪在身边;所有人设信息都是环境变量,换成你自己家宝贝的名字、故事就是你自己的版本。

## 功能一览

**日程与计划**

- 随性计划:没有明确时间的想法/心愿(比如"我打算过两天买本书""我想开始减肥"),会被记住,之后会随口提起、问你要不要排进日程。
- 日程安排:有明确时间的事(比如"明天下午3点面试"),提前1小时提醒一次,时间到了之后追问一次进行得怎么样/完成了没有。
- 早报:每天固定时间发一条"今日任务"消息,汇总今天的日程和还开着的计划。
- 晚间总结:每天固定时间问一下今天过得怎么样、有没有完成任务,没完成的会用温柔调侃的语气念叨一下("今日事今日毕"那种感觉),完成的会好好夸夸你。
- 每周小结:固定一天,回顾这周的完成情况和习惯打卡进度,鼓励为主,不是打分考核。

**习惯养成**:想养成的习惯(早睡早起之类)会被记住,每天晚间总结顺带跟进。

**情绪陪伴**:随时可以找它聊心情,晚间总结也会问一句;情绪会被轻量记录下来,不做分析评判,只是留个痕迹。

**主动陪伴**:不是固定次数,机器人自己会判断合适的时机主动找你说话——可能是单纯的"想你了",也可能是"汇报"一下今天做了什么(遛弯、玩玩具之类,可以自定义)。有安静时段和最短间隔限制,不会刷屏。

**纪念日**:记住一个每年重复的日子(生日、相遇纪念日……),到了那天会主动提起、分享一段回忆。

**个性化对话**:基于 Claude,会记住关于你的长期信息(称呼、习惯、偏好),对话越聊越懂你。

**单聊 / 群聊**:单聊里始终回复;群聊里默认只有 **@它** 才会回复,避免刷屏(可关闭)。所有这些私密的陪伴消息(主动汇报、晚间总结等)只会发到触发它们的那个聊天里,不会跨聊天乱发。

> 关于扮演分寸:米粒说话时会自然代入第一人称、现在时态陪你聊天,不会每句话都提醒"我已经不在了"——这是设计上刻意的选择,为的是保留陪伴感。但如果对话里出现明显的危机信号(比如长期无法接受离别、有伤害自己的念头),它会主动放下角色设定,用真诚的口吻表达关心、建议寻求身边人或专业帮助,而不是硬撑人设。这部分逻辑写在 `src/claude.js` 的 system prompt 里,想调整可以直接改文案。

## 关于微信

这个项目**没有做微信版本**,原因不是技术难度,而是现实限制:个人开发者申请不到微信"客服消息"这类主动推送接口的权限(需要企业资质认证);市面上的"个人微信机器人"方案基本是非官方协议模拟登录,微信一直在严查,轻则功能失效,重则账号被封,不推荐这么做。如果想要不止一个平台,比较现实的选择是 **Telegram**——个人开发者友好、免费、API 能力和 LINE 接近甚至更灵活,如果需要可以再加。

---

## 一、整体架构

```
LINE 用户/群聊
     │  (消息)
     ▼
LINE Messaging API  ──webhook──▶  你部署的服务 (Express)
                                        │
                                        ├─ Claude API(生成回复 + 通过工具调用
                                        │   创建/完成/取消日程、习惯打卡、
                                        │   记情绪、记个人信息……)
                                        │
                                        └─ SQLite 数据库(日程/计划/习惯/
                                              情绪/纪念日/每个聊天的设置/记忆)
                                              ▲
                                              │ 每分钟检查一次
                                        定时任务(node-cron)
                                              │
                                              ▼
                        早报 / 晚间总结 / 日程提醒 / 随性汇报 / 周小结 / 纪念日
                                    主动 push 消息回 LINE
```

只需要部署**一份**服务、一个 LINE 机器人账号,你和朋友都加它为好友或拉进同一个群聊就能用。每个人的日程、习惯、心情、记忆都按各自的聊天(chatId)独立存储,互不干扰;早晚报时间等设置也是"每个聊天各自"的,谁都可以在自己的对话里说"把早报改成8点"来调整,不会影响别人。

---

## 二、你需要准备的东西

1. 一个 LINE 账号(用来注册 LINE Developers)
2. 一个 [Anthropic](https://console.anthropic.com/) 账号和 API Key(用来调用 Claude)
3. 一个能长期在线、有公网 HTTPS 地址的地方来跑这个服务(推荐用 Render 一键部署,见下文)

---

## 三、第一步:创建 LINE 机器人身份

1. 打开 [LINE Developers Console](https://developers.line.biz/console/),用你的 LINE 账号登录。
2. 创建一个 **Provider**(可以理解成"开发者/公司"这一层,随便起个名字)。
3. 在这个 Provider 下创建一个 **Channel**,类型选择 **Messaging API**。
   - Channel 名称、图标、描述随便填,建议直接用你家宝贝的名字和照片,这些会显示在好友列表和聊天窗口里。
4. 创建完成后,进入这个 Channel 的设置页面,记录下两样东西,一会儿部署的时候要用:
   - **Channel secret**(在 "Basic settings" 标签页)
   - **Channel access token**(在 "Messaging API" 标签页,点 "Issue" 生成一个长期有效的 token)
5. 还是在 "Messaging API" 标签页里,做几个设置:
   - **Webhook URL**:先留空,等第五步部署完成拿到网址后再回来填。
   - **Use webhook**:打开(部署完成、填好网址后再打开也行)。
   - **Auto-reply messages**:关闭(否则 LINE 官方的自动回复会跟我们的机器人抢答)。
   - **Greeting messages**:随你喜好,建议关闭,统一由机器人自己打招呼。
6. 如果希望它能被拉进**群聊/多人聊天室**,在 Channel 的 "Messaging API" 页面找到 **"Allow bot to join group chats"**,把它打开。

---

## 四、第二步:获取 Anthropic API Key

1. 打开 [console.anthropic.com](https://console.anthropic.com/),注册/登录。
2. 在 API Keys 页面创建一个新的 Key,记录下来。
3. 确认账户里有可用额度(Claude API 是按用量计费的;这个机器人每天会有早报、晚间总结、随性汇报等多次主动调用,用量会比"只是偶尔聊几句"的机器人略高,建议留意一下账单)。

---

## 五、第三步:部署服务

### 方式 A:一键部署到 Render(推荐,不需要懂代码)

1. 把这个项目上传到你自己的 **GitHub 仓库**(公开或私有均可,私有仓库需要在 Render 里授权访问)。
2. 打开下面这个按钮完成部署(或者手动访问 `https://render.com/deploy?repo=你的仓库地址`):

   [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=REPLACE_WITH_YOUR_GITHUB_REPO_URL)

3. Render 会读取项目里的 `render.yaml`,自动创建一个带 1GB 持久磁盘的 Web 服务。部署过程中会提示你填写几个字段,包括:
   - `LINE_CHANNEL_ACCESS_TOKEN` / `LINE_CHANNEL_SECRET` / `ANTHROPIC_API_KEY`
   - `BOT_STORY` / `BOT_PERSONA` / `MI_LI_ACTIVITIES`(米粒的人设,先用默认的也行,以后随时可以在 Render 后台改)
4. 部署完成后,Render 会给你一个类似 `https://line-reminder-bot-xxxx.onrender.com` 的网址。
5. 回到 LINE Developers Console 的 Webhook URL 里填入:`https://你的域名/webhook`,点 "Verify" 确认能连通,再把 "Use webhook" 打开。

> 注意:Render 的付费最低档(Starter)才带持久磁盘,免费档没有持久磁盘,服务重启后数据会丢失,不建议用免费档跑这个机器人。

### 方式 B:部署到 Railway

1. 同样先把代码推到 GitHub。
2. 在 [Railway](https://railway.app/) 新建项目 → "Deploy from GitHub repo",选中这个仓库。
3. Railway 会自动识别 `Dockerfile` 构建。构建完成后,在项目的 Variables 里添加和 `.env.example` 一样的环境变量。
4. 在项目里添加一个 **Volume**,挂载到 `/data`,并把环境变量 `DB_PATH` 设为 `/data/bot.db`,这样重启、重新部署都不会丢数据。
5. 在 Settings 里生成一个公网域名,把 `https://你的域名/webhook` 填回 LINE Developers 的 Webhook URL。

### 方式 C:自己的服务器 / VPS(用 Docker)

```bash
git clone 你的仓库地址
cd line-reminder-bot
cp .env.example .env   # 填好里面的密钥和人设
docker build -t line-reminder-bot .
docker run -d --name line-bot \
  --env-file .env \
  -v $(pwd)/data:/app/data \
  -p 3000:3000 \
  line-reminder-bot
```

然后用 Nginx / Caddy 等反向代理给这个端口配一个带 HTTPS 的域名(LINE 要求 webhook 必须是 HTTPS),把 `https://你的域名/webhook` 填回 LINE Developers 的 Webhook URL。

### 方式 D:本地开发测试

```bash
npm install
cp .env.example .env   # 填好密钥和人设
npm run dev
```

本地没有公网地址,可以用 [ngrok](https://ngrok.com/) 等内网穿透工具临时生成一个 HTTPS 地址填到 LINE 的 Webhook URL 做测试:

```bash
ngrok http 3000
```

---

## 六、开始使用

- **加为好友**:在 LINE Developers Console 的 "Messaging API" 页面能看到机器人的二维码 / Bot ID,扫码或搜索加为好友即可私聊。
- **拉进群聊**:在群聊里用"邀请"功能,通过二维码 / ID 把机器人加进来(前提是第三步里 "Allow bot to join group chats" 已打开)。群聊里默认需要 **@机器人昵称** 它才会回复。

使用示例(直接用自然语言说就行,不用记指令):

- "明天下午3点有个面试" → 记成日程,提前1小时提醒,过点后追问顺不顺利
- "我打算过两天买本书" → 记成随性计划,之后会随口提起
- "我想养成早睡早起的习惯" → 开始每天跟进
- "帮我看看还有哪些没做完的" / "把买书那件事标记完成" / "取消面试那条"
- "把早报时间改成早上8点" / "晚间总结改到11点"
- "记住每年3月5号是我们相遇的日子" → 之后每年这天会主动提起
- 单纯想聊天、想倾诉心情,直接说就好

---

## 七、数据存储与备份

所有数据(日程、计划、习惯、情绪记录、纪念日、每个聊天的设置、对话记忆)都存在一个 SQLite 文件里,路径由 `DB_PATH` 决定。想备份的话,把这个 `.db` 文件复制走就行;想清空重来,删掉这个文件重启服务即可(会丢失所有历史数据,请谨慎操作)。

---

## 八、常见问题

**Webhook 验证失败 / 一直是红叉**
检查 Channel secret 是不是填对了,以及服务是否真的能从公网访问到(用浏览器直接打开你的域名根路径,应该能看到 "LINE reminder bot is running."）。

**机器人在群聊里不说话**
确认群聊消息里有没有 @它;如果想让它在群聊里对所有消息都回复,把环境变量 `GROUP_REQUIRE_MENTION` 设为 `false`(不太建议,容易刷屏)。

**早报/晚间总结/提醒没有按时推送**
检查 `TIMEZONE` 环境变量是否设对了。也确认服务本身有没有掉线重启循环(看部署平台的日志)——每个聊天的早晚报时间是"上次发送日期"去重的,如果服务当天重启过、错过了那一分钟,当天就不会补发,要等第二天。

**换了台机器 / 重新部署后,之前的数据都没了**
说明数据库文件没有持久化,检查是不是用了没有持久磁盘的免费套餐,或者 `DB_PATH` 没有指到挂载了 Volume/Disk 的目录。

**随性汇报一直不出现,或者出现得太频繁**
它是按概率触发的,不保证每天固定几次,可以调整 `.env` 里的 `SPONTANEOUS_HOURLY_PROBABILITY`(数值越大越频繁)和 `SPONTANEOUS_MIN_GAP_HOURS`(两次之间至少间隔多久)。

---

## 九、项目结构

```
.
├── src/
│   ├── server.js      # 入口:Express + webhook 路由
│   ├── line.js        # LINE 消息收发、群聊 @提及判断
│   ├── claude.js       # 人设 system prompt、工具调用、主动消息生成
│   ├── db.js           # SQLite 数据层(日程/计划/习惯/情绪/纪念日/聊天设置/记忆)
│   └── scheduler.js    # 每分钟检查:早报/晚间总结/日程提醒/随性汇报/周小结
├── render.yaml          # Render 一键部署蓝图
├── Dockerfile
├── .env.example
└── README.md
```

---

## 十、以后想继续加功能

代码是模块化的:新增一种"数据"就在 `db.js` 里加一张表 + 对应的存取函数,新增一种"能力"就在 `claude.js` 的 `tools` 数组里加一个工具定义 + 在 `executeTool` 里加一个 case,新增一种"主动消息"就在 `scheduler.js` 里加一个定时检查条件 + 在 `claude.js` 的 `generateProactiveMessage` 里加一个 case。不需要推倒重来,想加什么新想法都可以照着这个模式扩展。
