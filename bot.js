const express = require("express");

const app = express();
app.use(express.json());

const APP_ID = process.env.LARK_APP_ID;
const APP_SECRET = process.env.LARK_APP_SECRET;

async function getTenantToken() {
  const response = await fetch(
    "https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        app_id: APP_ID,
        app_secret: APP_SECRET
      })
    }
  );

  const data = await response.json();

  if (data.code !== 0) {
    throw new Error(data.msg || "Unable to get Lark token");
  }

  return data.tenant_access_token;
}

async function sendLarkMessage(userId, message) {
  const token = await getTenantToken();

  const response = await fetch(
    `https://open.larksuite.com/open-apis/im/v1/messages?receive_id_type=user_id`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        receive_id: userId,
        msg_type: "text",
        content: JSON.stringify({
          text: message
        })
      })
    }
  );

  const data = await response.json();

  if (data.code !== 0) {
    throw new Error(data.msg || "Unable to send Lark message");
  }

  return data;
}

app.post("/send", async (req, res) => {
  try {
    const { user_id, message } = req.body;

    if (!user_id || !message) {
      return res.status(400).json({
        error: "user_id and message are required"
      });
    }

    const result = await sendLarkMessage(user_id, message);

    res.json({
      success: true,
      message_id: result?.data?.message_id
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.listen(3000, () => {
  console.log("Lark sender running on port 3000");
});