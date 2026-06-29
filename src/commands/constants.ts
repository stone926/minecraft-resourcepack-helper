export const defaultPackPng: string = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABX0lEQVQ4y3VSSUuDQQydXyN48OhCse4LVg+KFhcUaxXrMqJiFbwoIvKBIBQFexFcEHexrlAQix68+KOeJJCPNG0PmWSyvJdkxqXfYtj46MPaaw9mrxpZlp86MXlaC//Qhq2vIY4v3LUgdR3F/G0zps7r0Z+pwtJjO9z6ey8n7ufHsJMbwO7LIEaj1Zi7aULyooGBjn6mkSkkmISKKZ/AFu9b4Q4+J7jg5M9j5jLCDHRfyXWxpg63C3EcfieR/U2xbzhbg8RZHduODu89X0hWn7tDm4Q6IE3tkt6MR8IY2e7Yx9ggnd8b54D4dLIQSW4IIEnk1GC6UIOJTUKEjg7tDIKgKEHi2tZEzibrTnQ35fwMYJ1aS8u2WMecXYrdshU7itOMdmYBFr8eRXblys2lGejp9Aj6mfkjWacFqSTSVdEIJOmRjpLFyRiyF/1azibpDev5LVEJgP0DsqRK7y8E/2kQKqQTbHIJAAAAAElFTkSuQmCC";
export const errorMsg = {
  emptyInput: "input must not be empty",
  folderAlreadyExist: "folder already exist",
  invalidPackFormat: "input must be a pack format version such as 88.0 or 69"
};
export const promptMsg = {
  packName: "Please input the name of your resource pack",
  namespace: "Please input the namespace of your resource pack",
  packFormat: "Please input the target resource pack format",
  description: "Please input the description of your resource pack, can be empty"
};
export const defaultPackAttributes = {
  packFormat: "88.0",
  namespace: "minecraft"
};

type PackFormatValue = number | [number, number];

export function getPackMcmeta(packFormat: string, description: string): string {
  const format = parsePackFormatValue(packFormat);

  return JSON.stringify({
    pack: {
      ["min_format"]: format,
      ["max_format"]: format,
      description
    }
  }, null, 2);
}

export function isPackFormatVersion(input: string): boolean {
  return /^[1-9]\d*(?:\.(?:0|[1-9]\d*))?$/.test(input.trim());
}

function parsePackFormatValue(input: string): PackFormatValue {
  const parts = input.trim().split(".");
  const major = Number(parts[0]);
  const minor = parts[1] === undefined ? null : Number(parts[1]);
  return minor === null ? major : [major, minor];
}
