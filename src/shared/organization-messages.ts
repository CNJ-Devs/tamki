export const organizationMessages = {
  en: {
    organizationFileExclusions: "Remove supplementary material from library",
    organizationExcludeFile: "Exclude from library · {name}",
    organizationFileExclusionHelp:
      "Applying excludes checked supplementary files from the library index and normal rescans. Source media is preserved; these files will not remain as empty or duplicate works.",
    organizationRelationshipRemovals: "Remove series / collections",
    organizationRemoveRelationship: "Remove relationship · {name}",
    organizationRelationshipRemovalHelp:
      "Only checked series or collection records will be removed when you apply. Their works and source files are preserved.",
    organizationDeferred: "Deferred",
    organizationDeferredFeedback:
      "These related works are deferred from this application and remain pending for the next increment. You can still review and revise the current snapshot; affected proposals remain deferred.",
    organizationRelationshipRename: "Rename: {before} → {after}",
    organizationDeferredSummary:
      "{count} related proposals were deferred after removals or edits. Independent proposals can still be applied.",
    organizationAllDeferred:
      "All proposals are affected by removals, edits or scope changes. The draft is retained; regenerate before applying.",
    organizationDeferredHelp:
      "Deferred proposals remain visible and unapproved. They are not deleted or included in this application; their files, prior decisions and change evidence are included in the next incremental review.",
    organizationMode: "Review mode",
    organizationIncremental: "Incremental review",
    organizationFull: "Review everything again",
    organizationChanges: "Changes",
    organizationAdded: "Added / not yet approved",
    organizationModified: "Modified",
    organizationRemoved: "Removed",
    organizationAcknowledgeRemoval: "Confirm removal from library",
    organizationRemovalHelp:
      "Check only removals you accept. Applying removes these missing files from the library index; it does not delete source media. Unchecked items remain pending.",
    organizationBaselineHelp:
      "Only applied decisions count as approved. Unapplied drafts and unresolved items remain pending. A first review has no prior baseline.",
    organizationDeltaSummary:
      "This review: {pending} files · {unchanged} unchanged files retained",
    organizationLiveAdded:
      "{count} files were added after this snapshot. They are deferred to the next incremental review; this proposal can still be applied.",
    organizationLiveBlocked:
      "Files or organization data in this scope were removed or modified after the snapshot. This proposal is preserved, but must be regenerated before applying.",
    organizationNoChanges:
      "No pending changes. Applied decisions are retained.",
    smartOrganize: "Smart organization",
    organizationFeedback: "Review and feedback",
    organizationNoSeries: "No series suggestions",
    organizationUnselectedMembers:
      "First review and select these works in Works: {names}",
    organizationMembersDeferred: "Members deferred",
    organizationMembersUnselected: "Members not selected",
    organizationDeferredMembers:
      "These works are deferred to the next increment, so this relationship is also deferred: {names}",
    organizationFlaggedCount: "Flagged items · {count}",
    organizationReviewMeaning:
      "Lists model questions, changes to manual information, relationship name changes and unassigned files in this review. Deferred works are listed separately and remain pending for the next increment. Unflagged items have not necessarily been fact-checked; structural validation does not establish content identity.",
    organizationFeedbackLabel: "Your decisions or changes",
    organizationFeedbackPlaceholder:
      "Describe what to keep, correct or investigate.",
    organizationNoQuestions:
      "Nothing currently needs confirmation. You can still suggest changes to this plan.",
    organizationInspectPlan: "View plan",
    organizationRefine: "Revise plan",
    organizationRefining: "Revising",
    organizationFeedbackLimit:
      "This conversation is too long. Start a new plan with a summary of your decisions.",

    organizationScope: "Folders",
    organizationScopeHelp:
      "Uses each registered folder's scan depth. Directory names, filenames and current library metadata, order and collections are sent to your chosen AI connection. Removed items stay excluded; video contents are never sent.",
    organizationPreferences: "Organization preferences",
    organizationPreferencesPlaceholder:
      "For example: keep each season separate; place related works in a series.",
    organizationGenerate: "Generate plan",
    organizationWorks: "Works",
    organizationCollections: "Collections",
    organizationUnassigned: "Unassigned",
    organizationReview: "Review needed",
    organizationFiles: "{count} files",
    organizationCurrent: "Current work",
    organizationPreviously: "Previously",
    organizationMembershipChanged: "Files regrouped",
    organizationOrderChanged: "Order changed",
    organizationManualChanged: "Changes manual edits",
    organizationApply: "Apply organization",
    organizationApplyBody:
      "Apply the selected organization plan and keep playback progress. Unselected works stay unchanged.",
    organizationApplySourceFiles:
      "Source files will not be moved, renamed or deleted.",
    organizationApplyDeferred:
      "Skip {count} deferred works for now. Keep their current library records for the next incremental review.",
    organizationApplyFileExclusions:
      "Remove {count} selected supplementary files from the library. Future regular scans will also skip them; the source files are preserved.",
    organizationApplyMissingFiles:
      "Remove {count} selected missing-file records from the library. Unselected records stay unchanged.",
    organizationApplyRelationshipRemovals: "Remove these series / collections:",
    organizationApplyRelationshipRetention:
      "Only these groups will be removed. Their works and source files are preserved.",
    organizationApplied: "Organized {count} works",
    organizationScanning: "Reading folders",
    organizationGrouping: "Analyzing library structure",
    organizationValidating: "Checking and completing the plan",
    organizationReviewing: "Reviewing identities and relationships",
    organizationCollecting: "Reconciling the full library",
    organizationAnalyzingFiles: "{count} video files",
    organizationBusy: "Finish or cancel the current organization first.",
    organizationIncomplete:
      "Some folders could not be read. Check the storage connection and try again.",
    organizationTooLarge:
      "This scope is too large. Select fewer folders or reduce their scan depth.",
    organizationEmpty: "No eligible video files in these folders.",
    organizationInvalid:
      "The AI returned an incomplete or invalid grouping. Nothing was applied. Try again.",
    organizationStale:
      "The library changed while this plan was open. Generate a new plan before applying it.",
    organizationExpired: "This plan expired. Generate a new one.",
    organizationNoCollections: "No collection suggestions",
    organizationNoUnassigned: "All files have a suggested work",
    organizationNoGroups: "No work suggestions",
    organizationRegenerate: "Start again",
    organizationChooseFolders: "Choose at least one registered folder.",
    organizationNewWork: "Not yet in library",
    organizationDetails: "Show files",
    organizationSearchHelp:
      "Optional. Helps verify ambiguous titles and relationships; organizing filenames does not require web search.",
  },
  zh: {
    organizationFileExclusions: "将附加素材移出片库",
    organizationExcludeFile: "移出片库 · {name}",
    organizationFileExclusionHelp:
      "应用时将勾选的附加素材移出片库索引，普通重扫也会跳过；保留源文件，不留下只含这些素材的重复作品。",
    organizationRelationshipRemovals: "移除系列／合集",
    organizationRemoveRelationship: "移除关系 · {name}",
    organizationRelationshipRemovalHelp:
      "仅在应用时移除勾选的系列或合集记录，保留其中作品及源文件。",
    organizationDeferred: "暂缓处理",
    organizationDeferredFeedback:
      "这些关联作品不包含在本轮应用中，留待后续增量处理。仍可查看并修订当前快照的方案，受影响部分继续暂缓。",
    organizationRelationshipRename: "名称调整：{before} → {after}",
    organizationDeferredSummary:
      "有 {count} 个关联建议因删除或修改而暂缓，其余独立建议仍可应用。",
    organizationAllDeferred:
      "全部建议都受到删除、修改或范围变化的影响。草稿已保留，请重新生成后再应用。",
    organizationDeferredHelp:
      "暂缓建议仍保留在此处，不删除、不算已确认，也不包含在本轮应用中。相关文件、上次方案和变化依据会进入下一轮增量审阅。",
    organizationMode: "整理方式",
    organizationIncremental: "增量审阅",
    organizationFull: "重新全量检查",
    organizationChanges: "变更",
    organizationAdded: "新增／尚未确认",
    organizationModified: "修改",
    organizationRemoved: "移除",
    organizationAcknowledgeRemoval: "确认移除片库记录",
    organizationRemovalHelp:
      "仅勾选你认可的移除项。应用时清理这些已缺失文件的片库记录，不删除源文件；未勾选项下次继续待处理。",
    organizationBaselineHelp:
      "只有已应用的决定才算确认。未应用草稿和未确认项继续待处理；首次整理没有旧基准。",
    organizationDeltaSummary:
      "本轮审阅 {pending} 个文件 · 沿用 {unchanged} 个未变化文件",
    organizationLiveAdded:
      "快照之后又新增了 {count} 个文件，留待下次增量处理；当前方案仍可应用。",
    organizationLiveBlocked:
      "整理范围内的文件或组织信息在快照后发生了删除或修改。草稿已保留，请重新生成后再应用。",
    organizationNoChanges: "没有待处理变更，已应用的决定继续沿用。",
    smartOrganize: "智能整理",
    organizationFeedback: "确认与补充意见",
    organizationNoSeries: "暂无系列建议",
    organizationUnselectedMembers: "请先在作品页审阅并勾选以下成员：{names}",
    organizationMembersDeferred: "成员暂缓",
    organizationMembersUnselected: "成员未勾选",
    organizationDeferredMembers:
      "以下作品留待下次增量处理，此关系也随之暂缓：{names}",
    organizationFlaggedCount: "已标记待确认 · {count}",
    organizationReviewMeaning:
      "列出本轮模型疑点、手动信息变更、关系改名和未归组文件。暂缓作品单独列出，留待下次增量处理。未标记不代表已经完成事实核验；结构校验通过也不代表内容归属一定正确。",
    organizationFeedbackLabel: "你的判断或调整意见",
    organizationFeedbackPlaceholder: "说明哪些需要保留、调整或进一步核实。",
    organizationNoQuestions: "当前没有待确认项。你仍可对当前方案提出调整意见。",
    organizationInspectPlan: "查看方案",
    organizationRefine: "修订方案",
    organizationRefining: "正在修订",
    organizationFeedbackLimit: "本轮累计意见过长，请汇总判断后重新生成方案。",

    organizationScope: "整理范围",
    organizationScopeHelp:
      "按已注册目录的扫描层级读取。目录结构、文件名、已有片库信息、顺序和合集会发送给所选 AI 连接；跳过已移出的内容，不发送视频本身。",
    organizationPreferences: "整理偏好",
    organizationPreferencesPlaceholder:
      "例如：每一季独立成作品，相关作品归入同一系列。",
    organizationGenerate: "生成方案",
    organizationWorks: "作品",
    organizationCollections: "合集",
    organizationUnassigned: "未归组",
    organizationReview: "待确认",
    organizationFiles: "{count} 个文件",
    organizationCurrent: "当前作品",
    organizationPreviously: "原名称",
    organizationMembershipChanged: "归属调整",
    organizationOrderChanged: "顺序调整",
    organizationManualChanged: "涉及手动修改",
    organizationApply: "应用整理",
    organizationApplyBody:
      "将按已勾选的方案整理片库，并保留播放进度。未勾选的作品保持原状。",
    organizationApplySourceFiles: "源文件不会移动、重命名或删除。",
    organizationApplyDeferred:
      "本轮跳过 {count} 部暂缓作品，保留其当前片库记录，留待下次增量整理。",
    organizationApplyFileExclusions:
      "将勾选的 {count} 个附加素材从片库移除，后续普通扫描也会跳过；源文件保留。",
    organizationApplyMissingFiles:
      "将勾选的 {count} 个已缺失文件记录从片库移除。未勾选的记录保持不变。",
    organizationApplyRelationshipRemovals: "将移除以下系列／合集：",
    organizationApplyRelationshipRetention:
      "只移除这些分组，其中的作品和源文件都会保留。",
    organizationApplied: "已整理 {count} 个作品",
    organizationScanning: "读取目录",
    organizationGrouping: "整体分析片库结构",
    organizationValidating: "校验并补全方案",
    organizationReviewing: "复核作品与合集关系",
    organizationCollecting: "汇总整体整理方案",
    organizationAnalyzingFiles: "{count} 个视频文件",
    organizationBusy: "请先完成或取消当前整理。",
    organizationIncomplete: "部分目录读取失败，请检查存储连接后重试。",
    organizationTooLarge: "本次范围过大，请减少所选目录或降低扫描层级。",
    organizationEmpty: "所选目录中没有可整理的视频。",
    organizationInvalid:
      "AI 返回的归组不完整或无效，尚未应用任何改动，请重试。",
    organizationStale:
      "整理范围在预览期间发生了删除或修改，请重新生成方案后再应用。",
    organizationExpired: "方案已过期，请重新生成。",
    organizationNoCollections: "暂无合集建议",
    organizationNoUnassigned: "所有文件均已有归组建议",
    organizationNoGroups: "暂无作品建议",
    organizationRegenerate: "重新整理",
    organizationChooseFolders: "请至少选择一个已注册目录。",
    organizationNewWork: "尚未入库",
    organizationDetails: "查看文件",
    organizationSearchHelp:
      "可选，用来核实难以判断的作品名称与关联；根据文件名整理不依赖联网搜索。",
  },
} as const;
