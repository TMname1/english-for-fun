import { getHttp } from "./http";

export interface AuthUser {
  username: string;
}

export async function login(username: string, password: string) {
  return await getHttp()<AuthUser>("/auth/login", {
    method: "post",
    body: { username, password },
  });
}

export async function logout() {
  return await getHttp()<{ ok: boolean }>("/auth/logout", { method: "post" });
}

export async function fetchMe() {
  return await getHttp()<AuthUser>("/auth/me");
}
