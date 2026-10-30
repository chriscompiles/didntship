// Publish the owner's existing example without fabricating a purchase or replacing its history.
async function publishOwnerConfession(client) {
  await client.query(
    `UPDATE copes SET is_demo = FALSE, is_complimentary = TRUE
     WHERE id = $1 AND body = $2 AND handle = $3
       AND (is_demo = TRUE OR is_complimentary = TRUE)`,
    [3, "Spent the morning buying a domain instead of shipping the actual product", "chriscompiles"]
  );
}

module.exports = { publishOwnerConfession };
