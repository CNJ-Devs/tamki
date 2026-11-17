export const accountMessages = {
  en: {
    claudeProvider: "Claude · Official app login",
    googleProvider: "Gemini · Google Cloud login",
    claudeAccount: "Claude account",
    googleAccount: "Google account",
    claudeContinue: "Sign in with Claude Code",
    googleContinue: "Sign in with Google",
    claudeInstall: "Install Claude Code",
    claudePath: "Claude Code executable",
    claudeAutoDetect: "Detect installed Claude Code",
    claudeUsingPlan: "Using Claude subscription",
    claudeUsingAPI: "Using the official app’s API credentials",
    googleUsingCloud: "Using Google Cloud billing",
    googleClientId: "Desktop OAuth client ID",
    googleClientSecret: "OAuth client secret (optional)",
    googleSetup: "Set up OAuth",
    googleSetupHelp:
      "Create a Desktop app OAuth client in Google Cloud and enable the Generative Language API. Use its client ID and, if provided, client secret. During testing, add your Google account as a test user.",
    googleProject: "Billing project",
    googleChooseProject: "Choose a Google Cloud project",
    googleLoadProjects: "Refresh projects",
    googleBillingHelp:
      "The selected project needs Cloud Billing, the Generative Language API and permission to use services. Redeem eligible subscription Cloud credits in AI Studio. Chat subscription quotas do not apply.",
    googleBillingNotice:
      "API usage is billed to this project. Redeemed Cloud credits apply; usage beyond credits may be charged.",
    accountTestSearchHelp:
      "Makes a small model request with web search using this account’s billing or subscription allowance.",
    accountSignInRequired: "Sign in to this source again to continue.",
    accountUnavailable:
      "The account service is temporarily unavailable. Try again.",
    googleClientRequired: "Enter a Google Desktop OAuth client ID first.",
    accountRevocationUnconfirmed:
      "Disconnected in Tamki. Sign-out could not be confirmed; check the provider’s account settings.",
    googleClientInvalid:
      "Google rejected this OAuth client. Check its client ID and secret.",
    googleClientChanged: "Sign out before changing the OAuth client.",
    googleScopeRequired: "Grant Google Cloud access when signing in.",
    googleProjectRequired: "Choose a billing project first.",
    googleProjectDenied:
      "This account cannot use the selected project. Check project access and Service Usage permissions.",
    googleBillingRequired:
      "Enable billing and activate the paid balance for this project in AI Studio.",
    googleAPIDisabled: "Enable the Generative Language API for this project.",
    googleProjectsFailed: "Could not load Google Cloud projects. Try again.",
    claudeNotInstalled:
      "Claude Code was not found. Install the official app or select its executable in Advanced settings.",
    claudeRuntimeUnavailable:
      "Claude Code could not run. Check the executable and update the official app.",
    claudeRuntimeChanged:
      "Sign out before changing the Claude Code executable.",
    claudeModelsFailed:
      "Claude Code could not return its model list. Update the official app and sign in again.",
  },
  zh: {
    claudeProvider: "Claude · 官方程序登录",
    googleProvider: "Gemini · Google Cloud 登录",
    claudeAccount: "Claude 账号",
    googleAccount: "Google 账号",
    claudeContinue: "通过 Claude Code 登录",
    googleContinue: "通过 Google 登录",
    claudeInstall: "安装 Claude Code",
    claudePath: "Claude Code 程序路径",
    claudeAutoDetect: "自动检测已安装的 Claude Code",
    claudeUsingPlan: "使用 Claude 订阅",
    claudeUsingAPI: "使用官方程序的 API 凭证",
    googleUsingCloud: "使用 Google Cloud 计费",
    googleClientId: "桌面 OAuth 客户端 ID",
    googleClientSecret: "OAuth 客户端密钥（可选）",
    googleSetup: "配置 OAuth",
    googleSetupHelp:
      "在 Google Cloud 创建“桌面应用”OAuth 客户端并启用 Generative Language API，填入客户端 ID 和提供的客户端密钥。测试阶段需将自己的 Google 账号加入测试用户。",
    googleProject: "计费项目",
    googleChooseProject: "选择 Google Cloud 项目",
    googleLoadProjects: "刷新项目",
    googleBillingHelp:
      "项目需开启 Cloud Billing 和 Generative Language API，并授予服务使用权限。订阅赠送的 Cloud 额度需先在 AI Studio 领取；聊天订阅限额不适用于此处。",
    googleBillingNotice:
      "API 用量计入此项目。已领取的 Cloud 额度可抵扣，超出后可能产生费用。",
    accountTestSearchHelp:
      "发送一次小型联网模型请求，使用此账号的订阅额度或 API 计费。",
    accountSignInRequired: "请重新登录此来源后继续。",
    accountUnavailable: "账号服务暂时不可用，请稍后重试。",
    googleClientRequired: "请先填写 Google 桌面 OAuth 客户端 ID。",
    accountRevocationUnconfirmed:
      "已在 Tamki 断开连接，但未确认服务端已退出；请检查该服务的账号设置。",
    googleClientInvalid:
      "Google 未接受此 OAuth 客户端，请检查客户端 ID 和密钥。",
    googleClientChanged: "请先退出登录，再修改 OAuth 客户端。",
    googleScopeRequired: "登录时需要授予 Google Cloud 访问权限。",
    googleProjectRequired: "请先选择计费项目。",
    googleProjectDenied:
      "当前账号无法使用该项目，请检查项目访问权限和 Service Usage 权限。",
    googleBillingRequired: "请在 AI Studio 为此项目启用计费并激活付费余额。",
    googleAPIDisabled: "请为此项目启用 Generative Language API。",
    googleProjectsFailed: "无法获取 Google Cloud 项目，请重试。",
    claudeNotInstalled:
      "未找到 Claude Code，请安装官方程序，或在高级设置中指定程序路径。",
    claudeRuntimeUnavailable:
      "无法运行 Claude Code，请检查程序路径并更新官方程序。",
    claudeRuntimeChanged: "请先退出登录，再修改 Claude Code 程序路径。",
    claudeModelsFailed:
      "Claude Code 未返回模型列表，请更新官方程序并重新登录。",
  },
} as const;
