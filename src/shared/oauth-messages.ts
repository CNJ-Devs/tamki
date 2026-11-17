// Shared with the main-process loopback response. No credentials enter these catalogs.
export const oauthMessages = {
  en: {
    oauthProvider: "OpenAI · ChatGPT login",
    oauthAccount: "ChatGPT account",
    oauthSavedIdentity: "Saved authorization",
    oauthOtherAccount: "Add another account or workspace",
    oauthRegistrationIncomplete: "Authorization incomplete",
    oauthContinue: "Continue with ChatGPT",
    oauthSignOut: "Sign out",
    oauthSignedOut: "Not signed in",
    oauthWaiting: "Waiting for authorization…",
    oauthAuthorizationURL: "Authorization link",
    oauthPreparingLink: "Preparing authorization link…",
    oauthFinishing: "Completing authorization…",
    oauthCopyLink: "Copy link",
    oauthLinkCopied: "Link copied",
    oauthOpenDefault: "Open in browser",
    oauthStartAuthorization: "Start authorization",
    oauthLinkCancelled: "Cancelled · link expired",
    oauthLinkExpired: "Authorization link expired",
    oauthCancelAuthorization: "Cancel authorization",
    oauthLinkExpires: "Expires in {time}",
    oauthBrowserOpenFailed:
      "Could not open the browser. Copy the link or try opening it again.",
    oauthCopyFailed:
      "Could not copy the link. Select the address and copy it manually.",
    oauthUsingPlan: "Using ChatGPT plan",
    oauthManageUsage: "Manage usage",
    oauthWelcome: "You’re using your ChatGPT plan",
    oauthWelcomeBody:
      "Eligible requests use your ChatGPT plan or credits. You can manage Tamki’s allowance in ChatGPT settings.",
    oauthGotIt: "Got it",
    oauthTestSearch: "Test web search",
    oauthTestSearchHelp:
      "Sends a small search request using the selected model and your ChatGPT allowance. No library information is sent.",
    oauthSearchVerified: "Web search verified",
    oauthSearchUntested: "Web search not verified",
    oauthSearchTesting: "Testing web search…",
    oauthCallbackReceived:
      "Authorization received. Return to Tamki to finish connecting.",
    oauthCallbackFailed:
      "This authorization callback is invalid. Return to Tamki and try again.",
    oauthSignInRequired: "Sign in to ChatGPT again to continue.",
    oauthPlanRequired:
      "ChatGPT plan usage has not been authorized. Continue with ChatGPT to enable it.",
    oauthBusy:
      "Wait for the current authorization or connection test to finish.",
    oauthCancelled: "Authorization or connection test cancelled.",
    oauthDeclined: "Authorization was declined. You can try again when ready.",
    oauthAccountMismatch:
      "This authorization belongs to a different account. Add another source to use that account.",
    oauthClientInvalid:
      "OpenAI did not accept the saved registration. Check Tamki’s access in ChatGPT settings; the existing identity has been retained.",
    oauthRestricted:
      "The account, workspace or serving policy does not allow this request.",
    oauthUnavailable:
      "ChatGPT plan access is temporarily unavailable. Try again later.",
    oauthUsageLimit:
      "The ChatGPT plan or Tamki allowance has been reached. Review it in Manage usage.",
    oauthCapabilityUnsupported:
      "This model or account does not support the requested capability.",
    oauthStreamInterrupted:
      "The response ended before completion. No information was changed.",
    oauthSearchUnverified:
      "This response did not contain a completed web search.",
    oauthRevocationUnconfirmed:
      "Signed out locally. Remote revocation could not be confirmed; disconnect Tamki in ChatGPT settings if needed.",
  },
  zh: {
    oauthProvider: "OpenAI · ChatGPT 登录",
    oauthAccount: "ChatGPT 账号",
    oauthSavedIdentity: "已保存的授权",
    oauthOtherAccount: "添加其他账号或工作区",
    oauthRegistrationIncomplete: "授权未完成",
    oauthContinue: "通过 ChatGPT 继续",
    oauthSignOut: "退出登录",
    oauthSignedOut: "未登录",
    oauthWaiting: "等待授权…",
    oauthAuthorizationURL: "授权地址",
    oauthPreparingLink: "正在生成授权地址…",
    oauthFinishing: "正在完成授权…",
    oauthCopyLink: "复制链接",
    oauthLinkCopied: "已复制链接",
    oauthOpenDefault: "用浏览器打开",
    oauthStartAuthorization: "开始授权",
    oauthLinkCancelled: "已取消，链接已失效",
    oauthLinkExpired: "授权地址已失效",
    oauthCancelAuthorization: "取消授权",
    oauthLinkExpires: "{time} 后失效",
    oauthBrowserOpenFailed: "未能打开浏览器，可以复制链接或重新打开。",
    oauthCopyFailed: "未能复制链接，请选中地址后手动复制。",
    oauthUsingPlan: "使用 ChatGPT 套餐",
    oauthManageUsage: "管理用量",
    oauthWelcome: "已启用 ChatGPT 套餐",
    oauthWelcomeBody:
      "符合条件的请求将使用你的 ChatGPT 套餐或点数额度。可以在 ChatGPT 设置中管理 Tamki 的使用额度。",
    oauthGotIt: "知道了",
    oauthTestSearch: "检测联网搜索",
    oauthTestSearchHelp:
      "使用所选模型和 ChatGPT 额度发起一次小型搜索请求，不发送片库信息。",
    oauthSearchVerified: "联网搜索已验证",
    oauthSearchUntested: "联网搜索未验证",
    oauthSearchTesting: "正在检测联网搜索…",
    oauthCallbackReceived: "已收到授权，请返回 Tamki 完成连接。",
    oauthCallbackFailed: "授权回调无效，请返回 Tamki 重试。",
    oauthSignInRequired: "请重新登录 ChatGPT 后继续。",
    oauthPlanRequired:
      "尚未授权使用 ChatGPT 套餐，请通过 ChatGPT 继续完成授权。",
    oauthBusy: "请等待当前授权或连接检测完成。",
    oauthCancelled: "已取消授权或连接检测。",
    oauthDeclined: "未获得授权，可以稍后重试。",
    oauthAccountMismatch: "这次授权的账号不同，请添加另一个来源来使用该账号。",
    oauthClientInvalid:
      "OpenAI 未接受已保存的注册，请在 ChatGPT 设置中检查 Tamki 的授权；原有身份已保留。",
    oauthRestricted: "当前账号、工作区或服务策略不允许此请求。",
    oauthUnavailable: "ChatGPT 套餐调用暂时不可用，请稍后重试。",
    oauthUsageLimit:
      "已达到 ChatGPT 套餐或 Tamki 的使用额度，请在“管理用量”中查看。",
    oauthCapabilityUnsupported: "当前模型或账号不支持所请求的能力。",
    oauthStreamInterrupted: "响应在完成前中断，未修改任何信息。",
    oauthSearchUnverified: "本次响应未包含已完成的联网搜索。",
    oauthRevocationUnconfirmed:
      "已在本机退出，但未确认远端授权已撤销；需要时可在 ChatGPT 设置中断开 Tamki。",
  },
};
