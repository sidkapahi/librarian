const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  PermissionFlagsBits,
} = require("discord.js");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

// ─── Config ────────────────────────────────────────────────────────────────
const config = {
  DISCORD_TOKEN: process.env.DISCORD_TOKEN,
  DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID,
  DISCORD_GUILD_ID: process.env.DISCORD_GUILD_ID || null,
  BOOKSHELF_URL: process.env.BOOKSHELF_URL,
  BOOKSHELF_API_KEY: process.env.BOOKSHELF_API_KEY,
  REQUEST_CHANNEL_ID: process.env.REQUEST_CHANNEL_ID || null,
  ADMIN_ROLE_ID: process.env.ADMIN_ROLE_ID || null,
  ADMIN_USER_ID: process.env.ADMIN_USER_ID || null,
  LOG_FILE: process.env.LOG_FILE || "/config/curatarr.log",
  REQUIRE_APPROVAL: process.env.REQUIRE_APPROVAL === "true",
  QUALITY_PROFILE_NAME: process.env.QUALITY_PROFILE_NAME || "Spoken",
  METADATA_PROFILE_NAME: process.env.METADATA_PROFILE_NAME || "None",
  TZ: process.env.TZ || "UTC",
};

// ─── Logger ────────────────────────────────────────────────────────────────
const logDir = path.dirname(config.LOG_FILE);
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

function log(level, message, data) {
  const timestamp = new Date().toLocaleString("en-CA", { timeZone: config.TZ, hour12: false });
  const entry = { timestamp, level, message };
  if (data) entry.data = data;
  fs.appendFileSync(config.LOG_FILE, JSON.stringify(entry) + "\n");
  console.log("[" + timestamp + "] [" + level + "] " + message, data || "");
}

// ─── Bookshelf API ─────────────────────────────────────────────────────────
const bsApi = axios.create({
  baseURL: config.BOOKSHELF_URL + "/api/v1",
  headers: { "X-Api-Key": config.BOOKSHELF_API_KEY },
  timeout: 15000,
});

async function searchBooks(term) {
  log("INFO", "Searching Bookshelf", { term });
  const res = await bsApi.get("/book/lookup", { params: { term } });
  return res.data.slice(0, 10);
}

async function getRootFolder() {
  const res = await bsApi.get("/rootfolder");
  if (!res.data || res.data.length === 0) throw new Error("No root folders configured in Bookshelf");
  return res.data[0].path;
}

async function getQualityProfileId() {
  const res = await bsApi.get("/qualityprofile");
  if (!res.data || res.data.length === 0) throw new Error("No quality profiles found");
  const match = res.data.find(function(p) { return p.name.toLowerCase() === config.QUALITY_PROFILE_NAME.toLowerCase(); });
  if (match) return match.id;
  log("WARN", "Quality profile not found by name, using first", { wanted: config.QUALITY_PROFILE_NAME });
  return res.data[0].id;
}

async function getMetadataProfileId() {
  const res = await bsApi.get("/metadataprofile");
  if (!res.data || res.data.length === 0) throw new Error("No metadata profiles found");
  const match = res.data.find(function(p) { return p.name.toLowerCase() === config.METADATA_PROFILE_NAME.toLowerCase(); });
  if (match) return match.id;
  log("WARN", "Metadata profile not found by name, using first", { wanted: config.METADATA_PROFILE_NAME });
  return res.data[0].id;
}

// ─── Author name parsing ───────────────────────────────────────────────────
// authorTitle format from Bookshelf: "lastname, firstname Book Title"
// Handles: "herbert, frank", "rowling, j.k.", "le guin, ursula k.",
//          "tolkien, j.r.r.", "garcia marquez, gabriel", "o'brien, tim"
var AUTHOR_REGEX = /^([a-z\-'\.]+(?:\s[a-z\-'\.]+)?,\s[a-z\-'\.\s]+?)\s+/i;

function formatName(n) {
  return n.trim().replace(/\b\w/g, function(c) { return c.toUpperCase(); });
}

function extractAuthorFromAuthorTitle(authorTitle) {
  if (!authorTitle) return null;
  var match = authorTitle.match(AUTHOR_REGEX);
  if (!match) return null;
  var parts = match[1].split(",").map(function(p) { return p.trim(); });
  var lastName = formatName(parts[0]);
  var firstName = parts[1] ? formatName(parts[1]) : "";
  return firstName ? firstName + " " + lastName : lastName;
}

function parseBookTitle(book) {
  var title = book.title || "";
  var author = extractAuthorFromAuthorTitle(book.authorTitle);

  // Fallback to structured author field
  if (!author && book.author && book.author.authorName) {
    var raw = book.author.authorName;
    // Handle "Last, First" format
    if (/^[^,]+,\s[^,]+$/.test(raw)) {
      var ap = raw.split(",").map(function(p) { return p.trim(); });
      author = formatName(ap[1]) + " " + formatName(ap[0]);
    } else {
      author = raw;
    }
  }

  return { title: title, author: author || "Unknown Author" };
}

// ─── Edition construction ──────────────────────────────────────────────────
// Bookshelf's /book/lookup never returns editions, but the POST /book endpoint
// requires them. We construct a minimal valid edition from the lookup data.
function buildEditionFromBook(book) {
  return {
    bookId: 0,
    foreignEditionId: book.foreignEditionId || book.titleSlug || "",
    titleSlug: book.foreignEditionId || book.titleSlug || "",
    isbn13: "",
    asin: "",
    title: book.title || "",
    overview: book.overview || "",
    format: "",
    pageCount: book.pageCount || 0,
    releaseDate: book.releaseDate || null,
    publisher: "",
    language: "eng",
    isEbook: false,
    monitored: true,
    manualAdd: false,
    grabbed: false,
    ratings: book.ratings || { votes: 0, value: 0, popularity: 0 },
    images: book.images || [],
    links: book.links || [],
  };
}

// ─── Add book to Bookshelf ─────────────────────────────────────────────────
async function addBook(book) {
  var parsed = parseBookTitle(book);
  log("INFO", "Adding book", { title: parsed.title, author: parsed.author });

  var rootFolder = await getRootFolder();
  var qualityProfileId = await getQualityProfileId();
  var metadataProfileId = await getMetadataProfileId();

  log("INFO", "Profiles resolved", { qualityProfileId, metadataProfileId, rootFolder });

  // ── Step 1: Find the author foreignAuthorId via lookup ──
  var authorForeignId = null;
  var authorName = extractAuthorFromAuthorTitle(book.authorTitle) ||
    (book.author && book.author.authorName) || null;

  if (authorName) {
    try {
      var authorSearch = await bsApi.get("/author/lookup", { params: { term: authorName } });
      if (authorSearch.data && authorSearch.data.length > 0) {
        // Try to find best match by last name
        var lastName = book.authorTitle ? book.authorTitle.split(",")[0].trim().toLowerCase() : "";
        var bestMatch = authorSearch.data.find(function(a) {
          return a.authorNameLastFirst && a.authorNameLastFirst.toLowerCase().startsWith(lastName);
        }) || authorSearch.data[0];
        authorForeignId = bestMatch.foreignAuthorId;
        log("INFO", "Author found", { name: authorName, foreignAuthorId: authorForeignId });
      }
    } catch (e) {
      log("WARN", "Author lookup failed", { error: e.message });
    }
  }

  // ── Step 2: Ensure author exists in Bookshelf ──
  if (authorForeignId) {
    try {
      await bsApi.post("/author", {
        foreignAuthorId: authorForeignId,
        qualityProfileId: qualityProfileId,
        metadataProfileId: metadataProfileId,
        rootFolderPath: rootFolder,
        monitored: true,
        monitorNewItems: "none",
        addOptions: { monitor: "none", booksToMonitor: [], searchForMissingBooks: false },
      });
      log("INFO", "Author added to Bookshelf");
    } catch (e) {
      // 409/500 usually means already exists — that's fine
      log("INFO", "Author already in Bookshelf (or add skipped)", { status: e.response && e.response.status });
    }
  }

  // ── Step 3: Build the book payload with constructed edition ──
  var edition = buildEditionFromBook(book);

  var payload = {
    title: book.title,
    foreignBookId: book.foreignBookId,
    titleSlug: book.titleSlug || book.foreignBookId,
    monitored: true,
    anyEditionOk: true,
    editions: [edition],
    addOptions: { searchForNewBook: true },
    ratings: book.ratings || { votes: 0, value: 0, popularity: 0 },
    releaseDate: book.releaseDate || null,
    genres: book.genres || [],
    images: book.images || [],
    links: book.links || [],
    overview: book.overview || "",
    seriesTitle: book.seriesTitle || "",
    disambiguation: book.disambiguation || "",
    pageCount: book.pageCount || 0,
    remoteCover: book.remoteCover || "",
    added: "0001-01-01T00:00:00Z",
    grabbed: false,
    authorId: 0,
    authorTitle: book.authorTitle || "",
  };

  if (authorForeignId) {
    payload.author = {
      foreignAuthorId: authorForeignId,
      qualityProfileId: qualityProfileId,
      metadataProfileId: metadataProfileId,
      rootFolderPath: rootFolder,
      monitored: true,
      monitorNewItems: "none",
      addOptions: {
        monitor: "none",
        booksToMonitor: [book.foreignBookId],
        searchForMissingBooks: false,
      },
    };
  }

  log("INFO", "Sending payload", {
    foreignBookId: book.foreignBookId,
    foreignEditionId: edition.foreignEditionId,
    hasAuthor: !!payload.author,
    authorForeignId,
  });

  var res = await bsApi.post("/book", payload).catch(function(e) {
    log("ERROR", "Book add failed", {
      status: e.response && e.response.status,
      message: e.response && e.response.data && e.response.data.message,
    });
    throw e;
  });

  log("INFO", "Book added successfully", { title: book.title, id: res.data.id });

  // ── Step 4: Explicitly trigger search ──
  try {
    await bsApi.post("/command", { name: "BookSearch", bookIds: [res.data.id] });
    log("INFO", "Search triggered", { bookId: res.data.id });
  } catch (e) {
    log("WARN", "Search trigger failed", { error: e.message });
  }

  return res.data;
}

async function getQueue() { var res = await bsApi.get("/queue"); return res.data; }
async function getLibrary() { var res = await bsApi.get("/book"); return res.data; }

// ─── Embeds ────────────────────────────────────────────────────────────────
function bookEmbedUser(book, status) {
  var cover = book.remoteCover || (book.images && book.images[0] && book.images[0].remoteUrl) || null;
  var parsed = parseBookTitle(book);
  var rating = book.ratings && book.ratings.value ? "⭐ " + book.ratings.value.toFixed(1) + "/5" : "";
  var pages = book.pageCount ? "📄 " + book.pageCount + " pages" : "";
  var year = book.releaseDate ? new Date(book.releaseDate).getFullYear() : "";
  var overview = book.overview || null;
  var color = status === "approved" ? 0x00ff00 : status === "denied" ? 0xff0000 : status === "pending" ? 0xffa500 : 0x5865f2;

  var embed = new EmbedBuilder()
    .setTitle(parsed.title)
    .setAuthor({ name: parsed.author })
    .setColor(color)
    .setFooter({ text: "Curatarr" })
    .setTimestamp();

  if (cover) embed.setImage(cover);
  if (overview) embed.setDescription(overview.slice(0, 350) + (overview.length > 350 ? "..." : ""));

  var fields = [];
  if (year) fields.push({ name: "Year", value: String(year), inline: true });
  if (rating) fields.push({ name: "Rating", value: rating, inline: true });
  if (pages) fields.push({ name: "Length", value: pages, inline: true });
  if (status) fields.push({ name: "Status", value: status.charAt(0).toUpperCase() + status.slice(1), inline: true });
  if (fields.length) embed.addFields(fields);

  return embed;
}

function bookEmbedAdmin(book, requester) {
  var embed = bookEmbedUser(book, "pending");
  embed.addFields({ name: "Requested by", value: requester, inline: true });
  return embed;
}

function isAdmin(member) {
  if (!member) return false;
  if (config.ADMIN_ROLE_ID) return member.roles.cache.has(config.ADMIN_ROLE_ID);
  return member.permissions.has(PermissionFlagsBits.Administrator);
}

async function getAdminUser(guild) {
  if (config.ADMIN_USER_ID) {
    try { return await client.users.fetch(config.ADMIN_USER_ID); }
    catch (e) { log("WARN", "Could not fetch ADMIN_USER_ID", { error: e.message }); }
  }
  try {
    var members = await guild.members.fetch();
    var admin = members.find(function(m) {
      return !m.user.bot && (config.ADMIN_ROLE_ID
        ? m.roles.cache.has(config.ADMIN_ROLE_ID)
        : m.permissions.has(PermissionFlagsBits.Administrator));
    });
    return admin ? admin.user : null;
  } catch (e) { log("WARN", "Could not find admin", { error: e.message }); return null; }
}

function buildSearchUI(results, userId) {
  var options = results.map(function(book, i) {
    var parsed = parseBookTitle(book);
    var year = book.releaseDate ? new Date(book.releaseDate).getFullYear() : "";
    return {
      label: parsed.title.slice(0, 100),
      description: (parsed.author + (year ? " (" + year + ")" : "")).slice(0, 100),
      value: String(i),
    };
  });

  var selectRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("select_book_" + userId)
      .setPlaceholder("Select a book here")
      .addOptions(options)
  );
  var buttonRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("new_search_" + userId)
      .setLabel("🔍 Search again")
      .setStyle(ButtonStyle.Secondary)
  );

  return { embed: bookEmbedUser(results[0]), selectRow, buttonRow };
}

// ─── Pending store ─────────────────────────────────────────────────────────
var PENDING_FILE = "/config/pending-requests.json";
var pendingRequests = {};

function loadPending() {
  try { if (fs.existsSync(PENDING_FILE)) pendingRequests = JSON.parse(fs.readFileSync(PENDING_FILE, "utf8")); }
  catch (e) { log("WARN", "Could not load pending requests", { error: e.message }); }
}

function savePending() {
  try { fs.writeFileSync(PENDING_FILE, JSON.stringify(pendingRequests, null, 2)); }
  catch (e) { log("ERROR", "Could not save pending requests", { error: e.message }); }
}

loadPending();

// ─── Discord Client ────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
  ],
});

const { REST, Routes } = require("discord.js");

var commands = [
  new SlashCommandBuilder().setName("request").setDescription("Request an audiobook")
    .addStringOption(function(o) { return o.setName("title").setDescription("Book title or author to search").setRequired(true); }),
  new SlashCommandBuilder().setName("status").setDescription("Check the download queue"),
  new SlashCommandBuilder().setName("library").setDescription("Search the existing library")
    .addStringOption(function(o) { return o.setName("query").setDescription("Book title to search for").setRequired(true); }),
  new SlashCommandBuilder().setName("pending").setDescription("View pending requests (admin only)"),
  new SlashCommandBuilder().setName("logs").setDescription("View recent bot logs (admin only)"),
].map(function(c) { return c.toJSON(); });

async function registerCommands() {
  var rest = new REST({ version: "10" }).setToken(config.DISCORD_TOKEN);
  try {
    log("INFO", "Registering slash commands...");
    var route = config.DISCORD_GUILD_ID
      ? Routes.applicationGuildCommands(config.DISCORD_CLIENT_ID, config.DISCORD_GUILD_ID)
      : Routes.applicationCommands(config.DISCORD_CLIENT_ID);
    await rest.put(route, { body: commands });
    log("INFO", "Slash commands registered");
  } catch (e) { log("ERROR", "Failed to register commands", { error: e.message }); }
}

// ─── Interaction Handler ───────────────────────────────────────────────────
client.on("interactionCreate", async function(interaction) {

  if (config.REQUEST_CHANNEL_ID && interaction.channelId !== config.REQUEST_CHANNEL_ID && interaction.isChatInputCommand()) {
    return interaction.reply({ content: "❌ Please use <#" + config.REQUEST_CHANNEL_ID + "> for book requests.", ephemeral: true });
  }

  // ── /request ──
  if (interaction.isChatInputCommand() && interaction.commandName === "request") {
    var query = interaction.options.getString("title");
    log("INFO", "Request command", { user: interaction.user.tag, query });
    await interaction.deferReply({ ephemeral: true });

    try {
      var results = await searchBooks(query);
      if (!results.length) return interaction.editReply({ content: "❌ No results found for **" + query + "**. Try a different search term." });

      var library = await getLibrary();
      var libraryIds = new Set(library.map(function(b) { return b.foreignBookId; }));
      var filtered = results.filter(function(b) { return !libraryIds.has(b.foreignBookId); });
      var alreadyHave = results.filter(function(b) { return libraryIds.has(b.foreignBookId); });

      if (alreadyHave.length && !filtered.length) {
        return interaction.editReply({ content: "✅ **" + parseBookTitle(alreadyHave[0]).title + "** is already in the library! Check Audiobookshelf." });
      }

      pendingRequests["search_" + interaction.user.id] = { results: filtered.slice(0, 10), timestamp: Date.now() };
      savePending();

      var ui = buildSearchUI(filtered.slice(0, 10), interaction.user.id);
      await interaction.editReply({
        content: "Please select a book from the list below",
        embeds: [],
        components: [ui.selectRow],
      });
    } catch (e) {
      log("ERROR", "Request command failed", { error: e.message });
      await interaction.editReply({ content: "❌ Error searching Bookshelf: " + e.message });
    }
  }

  // ── Select menu — show embed + Request button ──
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith("select_book_")) {
    var userId = interaction.customId.replace("select_book_", "");
    if (interaction.user.id !== userId) return interaction.reply({ content: "❌ This menu is not for you.", ephemeral: true });

    var stored = pendingRequests["search_" + userId];
    if (!stored) return interaction.reply({ content: "❌ Search expired. Please run `/request` again.", ephemeral: true });

    var book = stored.results[parseInt(interaction.values[0])];
    var parsed = parseBookTitle(book);

    pendingRequests["selected_" + userId] = { book: book, timestamp: Date.now() };
    savePending();

    var embed = bookEmbedUser(book);
    var options = stored.results.map(function(b, i) {
      var p = parseBookTitle(b);
      var y = b.releaseDate ? new Date(b.releaseDate).getFullYear() : "";
      return { label: p.title.slice(0, 100), description: (p.author + (y ? " (" + y + ")" : "")).slice(0, 100), value: String(i) };
    });

    var selectRow = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("select_book_" + userId)
        .setPlaceholder(parsed.title.slice(0, 100))
        .addOptions(options)
    );
    var buttonRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("confirm_request_" + userId).setLabel("Request").setStyle(ButtonStyle.Primary)
    );

    await interaction.update({ content: "", embeds: [embed], components: [selectRow, buttonRow] });
  }

  // ── Request button ──
  if (interaction.isButton() && interaction.customId.startsWith("confirm_request_")) {
    var userId = interaction.customId.replace("confirm_request_", "");
    if (interaction.user.id !== userId) return interaction.reply({ content: "❌ This button is not for you.", ephemeral: true });

    var selectedData = pendingRequests["selected_" + userId];
    if (!selectedData) return interaction.reply({ content: "❌ Session expired. Please run `/request` again.", ephemeral: true });

    var book = selectedData.book;
    var parsed = parseBookTitle(book);
    await interaction.deferUpdate();

    if (config.REQUIRE_APPROVAL && !isAdmin(interaction.member)) {
      var requestId = "req_" + Date.now() + "_" + userId;
      pendingRequests[requestId] = { book, requester: interaction.user.tag, requesterId: userId, timestamp: Date.now(), status: "pending" };
      delete pendingRequests["selected_" + userId];
      delete pendingRequests["search_" + userId];
      savePending();

      await interaction.editReply({
        content: "📋 Your request for **" + parsed.title + "** has been submitted. You'll get a DM when it's handled.",
        embeds: [bookEmbedUser(book, "pending")],
        components: [],
      });

      try {
        var adminUser = await getAdminUser(interaction.guild);
        if (adminUser) {
          await adminUser.send({
            content: "📬 New audiobook request from **" + interaction.user.tag + "**:",
            embeds: [bookEmbedAdmin(book, interaction.user.tag)],
            components: [new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId("approve_" + requestId).setLabel("✅ Approve").setStyle(ButtonStyle.Success),
              new ButtonBuilder().setCustomId("deny_" + requestId).setLabel("❌ Deny").setStyle(ButtonStyle.Danger)
            )],
          });
        }
      } catch (e) { log("ERROR", "Could not DM admin", { error: e.message }); }
    } else {
      delete pendingRequests["selected_" + userId];
      delete pendingRequests["search_" + userId];
      savePending();

      try {
        await addBook(book);
        await interaction.editReply({
          content: "✅ **" + parsed.title + "** has been added and is now searching for a download!",
          embeds: [bookEmbedUser(book, "approved")],
          components: [],
        });
      } catch (e) {
        log("ERROR", "Failed to add book", { error: e.message });
        await interaction.editReply({ content: "❌ Failed to add **" + parsed.title + "**: " + e.message, components: [] });
      }
    }
  }

  // ── Approve/Deny (from admin DM) ──
  if (interaction.isButton() && (interaction.customId.startsWith("approve_") || interaction.customId.startsWith("deny_"))) {
    var parts = interaction.customId.split("_");
    var action = parts[0];
    var requestId = parts.slice(1).join("_");
    var request = pendingRequests[requestId];

    if (!request) return interaction.reply({ content: "❌ Request not found or already handled.", ephemeral: true });
    await interaction.deferUpdate();
    var parsedBook = parseBookTitle(request.book);

    if (action === "approve") {
      try {
        await addBook(request.book);
        delete pendingRequests[requestId];
        savePending();
        var approveEmbed = bookEmbedAdmin(request.book, request.requester);
        approveEmbed.setColor(0x00ff00);
        await interaction.editReply({ content: "✅ **" + parsedBook.title + "** approved and added!", embeds: [approveEmbed], components: [] });
        try {
          var requesterUser = await client.users.fetch(request.requesterId);
          await requesterUser.send({ content: "✅ Your request for **" + parsedBook.title + "** has been approved and is now downloading!", embeds: [bookEmbedUser(request.book, "approved")] });
        } catch (e) { log("WARN", "Could not DM requester"); }
      } catch (e) {
        log("ERROR", "Approve failed", { error: e.message });
        await interaction.editReply({ content: "❌ Failed: " + e.message, components: [] });
      }
    }

    if (action === "deny") {
      delete pendingRequests[requestId];
      savePending();
      var denyEmbed = bookEmbedAdmin(request.book, request.requester);
      denyEmbed.setColor(0xff0000);
      await interaction.editReply({ content: "❌ **" + parsedBook.title + "** denied.", embeds: [denyEmbed], components: [] });
      try {
        var requesterUser2 = await client.users.fetch(request.requesterId);
        await requesterUser2.send({ content: "❌ Your request for **" + parsedBook.title + "** was denied.", embeds: [bookEmbedUser(request.book, "denied")] });
      } catch (e) { log("WARN", "Could not DM requester"); }
    }
  }

  // ── /status ──
  if (interaction.isChatInputCommand() && interaction.commandName === "status") {
    await interaction.deferReply({ ephemeral: true });
    try {
      var queue = await getQueue();
      var items = queue.records || queue || [];
      if (!items.length) return interaction.editReply({ content: "📭 The download queue is empty." });
      var qEmbed = new EmbedBuilder().setTitle("📥 Download Queue").setColor(0x5865f2).setTimestamp().setFooter({ text: "Curatarr" });
      items.slice(0, 10).forEach(function(item) {
        var size = item.size ? (item.size / 1024 / 1024).toFixed(0) + "MB" : "";
        qEmbed.addFields({ name: item.title || "Unknown", value: "Status: " + (item.status || "unknown") + (size ? " • " + size : ""), inline: false });
      });
      await interaction.editReply({ embeds: [qEmbed] });
    } catch (e) {
      log("ERROR", "Status failed", { error: e.message });
      await interaction.editReply({ content: "❌ Error: " + e.message });
    }
  }

  // ── /library ──
  if (interaction.isChatInputCommand() && interaction.commandName === "library") {
    var libQuery = interaction.options.getString("query").toLowerCase();
    await interaction.deferReply({ ephemeral: true });
    try {
      var lib = await getLibrary();
      var matches = lib.filter(function(b) {
        return (b.title && b.title.toLowerCase().includes(libQuery)) ||
          (b.author && b.author.authorName && b.author.authorName.toLowerCase().includes(libQuery));
      }).slice(0, 5);
      if (!matches.length) return interaction.editReply({ content: "❌ No books matching **" + libQuery + "** in the library." });
      await interaction.editReply({ content: "Found **" + matches.length + "** match(es):", embeds: matches.map(function(b) { return bookEmbedUser(b); }) });
    } catch (e) {
      log("ERROR", "Library failed", { error: e.message });
      await interaction.editReply({ content: "❌ Error: " + e.message });
    }
  }

  // ── /pending ──
  if (interaction.isChatInputCommand() && interaction.commandName === "pending") {
    if (!isAdmin(interaction.member)) return interaction.reply({ content: "❌ Admin only.", ephemeral: true });
    var pending = Object.entries(pendingRequests).filter(function(e) { return e[0].startsWith("req_") && e[1].status === "pending"; });
    if (!pending.length) return interaction.reply({ content: "📭 No pending requests.", ephemeral: true });
    await interaction.reply({ content: "📬 Sending **" + pending.length + "** pending request(s) to your DMs.", ephemeral: true });
    for (var pi = 0; pi < Math.min(pending.length, 5); pi++) {
      try {
        await interaction.user.send({
          content: "📋 Pending request:",
          embeds: [bookEmbedAdmin(pending[pi][1].book, pending[pi][1].requester)],
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("approve_" + pending[pi][0]).setLabel("✅ Approve").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("deny_" + pending[pi][0]).setLabel("❌ Deny").setStyle(ButtonStyle.Danger)
          )],
        });
      } catch (e) { log("WARN", "Could not DM admin pending"); }
    }
  }

  // ── /logs ──
  if (interaction.isChatInputCommand() && interaction.commandName === "logs") {
    if (!isAdmin(interaction.member)) return interaction.reply({ content: "❌ Admin only.", ephemeral: true });
    try {
      var lines = fs.readFileSync(config.LOG_FILE, "utf8").trim().split("\n").slice(-20);
      var parsedLines = lines.map(function(l) {
        try { var e = JSON.parse(l); return "`" + e.timestamp + "` **[" + e.level + "]** " + e.message; }
        catch (err) { return l; }
      });
      await interaction.reply({ content: "📋 **Recent logs:**\n" + parsedLines.join("\n"), ephemeral: true });
    } catch (e) { await interaction.reply({ content: "❌ Could not read logs: " + e.message, ephemeral: true }); }
  }

});

// ─── Ready ─────────────────────────────────────────────────────────────────
client.once("ready", async function() {
  log("INFO", "Bot online as " + client.user.tag);
  await registerCommands();
});

client.login(config.DISCORD_TOKEN).catch(function(e) {
  log("ERROR", "Login failed", { error: e.message });
  process.exit(1);
});
