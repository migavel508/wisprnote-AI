import { GoogleGenAI } from "@google/genai";
const ai = new GoogleGenAI({ apiKey: process.env.VITE_GEMINI_API_KEY });
async function test() {
  try {
    const res = await ai.models.embedContent({
      model: 'text-embedding-004',
      contents: "Hello world"
    });
    console.log(JSON.stringify(res, null, 2));
  } catch (e) {
    console.error(e);
  }
}
test();
