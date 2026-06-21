require('dotenv').config();
 
const apiKey = process.env.GEMINI_API_KEY;
console.log("Ключ загружен:", apiKey ? `да, длина ${apiKey.length}` : "НЕТ, undefined");
 
async function main() {
    try {
        const ipRes = await fetch("https://ipinfo.io/json");
        const ipData = await ipRes.json();
        console.log("Реальный IP, который видит Node:", JSON.stringify(ipData));
    } catch (err) {
        console.error("Не удалось проверить IP через Node:", err.message);
    }
 
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
    try {
        const res = await fetch(url);
        console.log("HTTP статус Gemini:", res.status);
        const data = await res.json();
        console.log("Ответ Gemini:", JSON.stringify(data).slice(0, 500));
    } catch (err) {
        console.error("ОШИБКА FETCH к Gemini:");
        console.error("Сообщение:", err.message);
        console.error("Причина (cause):", err.cause);
    }
}
 
main();