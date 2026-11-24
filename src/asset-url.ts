// WebView2 把自定义 scheme 改写为 http://<scheme>.localhost；直写 pet:// 会报 ERR_UNKNOWN_URL_SCHEME。
export const PET_ORIGIN = 'http://pet.localhost';
export const petUrl = (p: string) => `${PET_ORIGIN}/${p}`;
