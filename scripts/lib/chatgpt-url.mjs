export function normalizeComparableUrl(rawUrl) {
  const url = new URL(rawUrl);
  return `${url.origin}${url.pathname.replace(/\/+$/, "") || "/"}`;
}

export function normalizeOptionalComparableUrl(rawUrl) {
  if (!rawUrl) {
    return "";
  }

  try {
    return normalizeComparableUrl(rawUrl);
  } catch {
    return "";
  }
}

export function getInitialChatgptUrl(config) {
  return config.chatgpt.targetUrl || config.chatgpt.projectUrl || config.chatgpt.homeUrl;
}

export function isChatgptUrl(rawUrl, homeUrl) {
  return rawUrl.startsWith(homeUrl) || rawUrl.startsWith("https://chatgpt.com/");
}

export function isProjectHomeUrl(rawUrl, projectUrl) {
  return normalizeComparableUrl(rawUrl) === normalizeComparableUrl(projectUrl);
}

export function isConversationUrl(rawUrl, projectUrl) {
  const url = new URL(rawUrl);
  const project = new URL(projectUrl);
  const parts = url.pathname.split("/").filter(Boolean);
  const projectParts = project.pathname.split("/").filter(Boolean);

  return parts.length >= 4 && parts[0] === "g" && parts[1] === projectParts[1] && parts[2] === "c";
}

export function deriveProjectUrl(rawUrl) {
  const url = new URL(rawUrl);
  const parts = url.pathname.split("/").filter(Boolean);

  if (parts.length >= 3 && parts[0] === "g" && parts[2] === "project") {
    return `${url.origin}/g/${parts[1]}/project`;
  }

  if (parts.length >= 4 && parts[0] === "g" && parts[2] === "c") {
    return `${url.origin}/g/${parts[1]}/project`;
  }

  throw new Error(`Could not derive project URL from ${rawUrl}`);
}

export function deriveProjectUrlSafe(rawUrl) {
  try {
    return deriveProjectUrl(rawUrl);
  } catch {
    return "";
  }
}
