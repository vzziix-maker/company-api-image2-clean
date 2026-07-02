function pad2(value) {
  return String(value).padStart(2, "0");
}

function partsFromDate(date, timeZone) {
  if (!timeZone) {
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
    };
  }

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const valueByType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(valueByType.year),
    month: Number(valueByType.month),
    day: Number(valueByType.day),
    hour: Number(valueByType.hour),
    minute: Number(valueByType.minute),
  };
}

export function createImageDownloadFilename({ imageIndex = 0, outputFormat = "png", generatedAt, date = new Date(), timeZone } = {}) {
  const generatedDate = generatedAt ? new Date(generatedAt) : null;
  const safeDate = generatedDate instanceof Date && Number.isFinite(generatedDate.getTime())
    ? generatedDate
    : date instanceof Date && Number.isFinite(date.getTime())
      ? date
      : new Date();
  const parts = partsFromDate(safeDate, timeZone);
  const extension = outputFormat === "jpeg" ? "jpg" : outputFormat || "png";
  return `${parts.year}${pad2(parts.month)}${pad2(parts.day)}-${pad2(parts.hour)}:${pad2(parts.minute)}-${imageIndex + 1}.${extension}`;
}
