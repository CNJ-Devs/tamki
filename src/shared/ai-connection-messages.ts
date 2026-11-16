export const aiConnectionMessages = {
  en: {
    aiConnections: "AI connections",
    aiConnection: "AI connection",
    chooseAIConnection: "Choose an AI connection",
    manageAIConnections: "Manage AI connections",
    aiConnectionMissing:
      "This AI connection is unavailable. Choose another connection.",
    aiConnectionChanged:
      "The connection changed. Reload its models and try again.",
    addAIConnection: "Add AI connection",
    editAIConnection: "Edit AI connection",
    noAIConnections: "No AI connections",
    aiConnectionType: "Service type",
    aiConnectionInUse:
      "This connection is used by a recognition source. Switch or remove that source before removing the connection.",
    removeAIConnection: "Remove AI connection",
    removeAIConnectionTitle: "Remove this AI connection?",
    removeAIConnectionBody:
      "Its saved credentials will be removed and its account signed out. Your library will remain unchanged.",
    aiTestHelp:
      "Checks authentication and model catalog access without an inference request. Model and search permissions are checked when those features run.",
    aiConnectionNameTaken: "Use a different connection name.",
    aiNoAuthentication: "No authentication",
    aiAPIKeyProvider: "{name} · API Key",
  },
  zh: {
    aiConnections: "AI 连接",
    aiConnection: "AI 连接",
    chooseAIConnection: "选择 AI 连接",
    manageAIConnections: "管理 AI 连接",
    aiConnectionMissing: "此 AI 连接不可用，请选择其他连接。",
    aiConnectionChanged: "连接已变更，请重新获取模型后再试。",
    addAIConnection: "添加 AI 连接",
    editAIConnection: "编辑 AI 连接",
    noAIConnections: "暂无 AI 连接",
    aiConnectionType: "接入类型",
    aiConnectionInUse:
      "此连接正被识别来源使用，请先为来源更换连接或移除来源，再删除连接。",
    removeAIConnection: "删除 AI 连接",
    removeAIConnectionTitle: "删除这个 AI 连接？",
    removeAIConnectionBody: "将移除保存的凭据并退出该账号，片库内容保持不变。",
    aiTestHelp:
      "检查认证及模型目录访问，不发起推理请求。具体模型和联网权限在使用相应功能时验证。",
    aiConnectionNameTaken: "请使用不同的连接名称。",
    aiNoAuthentication: "无需认证",
    aiAPIKeyProvider: "{name} · API Key",
  },
} as const;
