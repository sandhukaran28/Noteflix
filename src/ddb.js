// ---- DynamoDB (audit log) ----
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");

const ddbClient = new DynamoDBClient({
  region: process.env.AWS_REGION || "ap-southeast-2",
  ...(process.env.DDB_LOCAL_ENDPOINT ? { endpoint: process.env.DDB_LOCAL_ENDPOINT } : {})
});
const ddb = DynamoDBDocumentClient.from(ddbClient);

const DDB_TABLE = process.env.DDB_TABLE || "n11845619-noteflix";
// Partition key name is fixed by CAB432 policy:
const DDB_PK_NAME = "qut-username";

// Helper: derive the QUT username for the PK value
function qutUsernameFromReqUser(user) {
  // Prefer an email-like ID if available; fall back to env
  return (process.env.QUT_USERNAME || "").toString();
}

// Write an audit event
async function putJobEvent(jobId, qutUsername, status, message = "") {
  if (!qutUsername) {
    console.warn("DDB putJobEvent skipped: missing qutUsername");
    return;
  }
  const now = new Date().toISOString();
  const item = {
    [DDB_PK_NAME]: qutUsername,
    sk: `JOB#${jobId}#EVENT#${now}#${status}`,
    jobId,
    status,
    message,
    createdAt: now
  };
  try {
    await ddb.send(new PutCommand({ TableName: DDB_TABLE, Item: item }));
  } catch (e) {
    console.warn("DDB putJobEvent failed:", e.message || e);
  }
}

// Read all events for a job for the current user
async function getJobEvents(jobId, qutUsername) {
  if (!qutUsername) throw new Error("missing qutUsername");
  const res = await ddb.send(new QueryCommand({
    TableName: DDB_TABLE,
    KeyConditionExpression: "#pk = :u AND begins_with(#sk, :prefix)",
    ExpressionAttributeNames: { "#pk": DDB_PK_NAME, "#sk": "sk" },
    ExpressionAttributeValues: {
      ":u": qutUsername,
      ":prefix": `JOB#${jobId}#EVENT#`
    }
  }));
  return res.Items || [];
}
module.exports = { putJobEvent, getJobEvents,qutUsernameFromReqUser };
