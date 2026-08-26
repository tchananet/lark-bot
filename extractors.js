const mammoth = require("mammoth");

async function extractWord(filePath) {
  const result = await mammoth.extractRawText({
    path: filePath,
  });

  return result.value.trim();
}

module.exports = {
  extractWord,
};