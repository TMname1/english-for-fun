import { parseDotEnv, parseEnableThinking } from "../config";

describe("parseDotEnv", () => {
  it("解析 KEY=VALUE / 引号 / 注释 / 显式空值", () => {
    const text = [
      "# comment",
      "A=1",
      'B="quoted value"',
      "C=",
      "D =  spaced  ",
      "E=inline # trimmed",
      "bad line",
      "1X=no",
      "F='single'",
    ].join("\n");
    expect(parseDotEnv(text)).toEqual({
      A: "1",
      B: "quoted value",
      C: "",
      D: "spaced",
      E: "inline",
      F: "single",
    });
  });

  it("容忍 BOM 与 CRLF", () => {
    expect(parseDotEnv("\uFEFFA=1\r\nB=2\r\n")).toEqual({ A: "1", B: "2" });
  });

  it("保留值中的等号与 #（引号内）", () => {
    expect(parseDotEnv("URL=https://x/y?a=b\nQ=keep # inside")).toEqual({
      URL: "https://x/y?a=b",
      Q: "keep",
    });
  });
});

describe("parseEnableThinking", () => {
  it("false/0 -> false，true/1 -> true，其余不发送", () => {
    expect(parseEnableThinking("false")).toBe(false);
    expect(parseEnableThinking("0")).toBe(false);
    expect(parseEnableThinking("true")).toBe(true);
    expect(parseEnableThinking("1")).toBe(true);
    expect(parseEnableThinking("")).toBeUndefined();
    expect(parseEnableThinking("  ")).toBeUndefined();
    expect(parseEnableThinking("none")).toBeUndefined();
  });
});
