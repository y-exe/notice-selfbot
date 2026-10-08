const TWITTER_BEARER_TOKEN =
    'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

function startGraphqlMonitor({ config, state, saveState, sendNotification }) {
    const initialCheckedUsers = new Set();
    const cachedTwitterUserIds = {};
    let timer;
    let stopped = false;
    async function getTwitterUserId(username, authToken, ct0) {
        if (cachedTwitterUserIds[username])
            return cachedTwitterUserIds[username];

        const url = `https://x.com/i/api/graphql/G3KGOASz96M-Qu0nwmGXNg/UserByScreenName?variables=${encodeURIComponent(JSON.stringify({ screen_name: username }))}`;
        const res = await fetch(url, {
            headers: {
                authorization: `Bearer ${TWITTER_BEARER_TOKEN}`,
                cookie: `auth_token=${authToken}; ct0=${ct0}`,
                'x-csrf-token': ct0,
                'x-twitter-active-user': 'yes',
                'x-twitter-auth-type': 'OAuth2Session',
                'user-agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            },
        });

        if (!res.ok) {
            throw new Error(
                `Failed to fetch user profile for ${username}: HTTP ${res.status}`,
            );
        }

        const data = await res.json();
        const userId = data?.data?.user?.result?.rest_id;
        if (!userId) {
            throw new Error(`User ID not found for ${username}`);
        }

        cachedTwitterUserIds[username] = userId;
        return userId;
    }

    async function fetchLatestTweet(username) {
        const authToken = process.env.TWITTER_AUTH_TOKEN;
        const ct0 = process.env.TWITTER_CT0;

        if (!authToken || !ct0) {
            console.warn(
                'TWITTER_AUTH_TOKEN or TWITTER_CT0 not set. Skipping Twitter check.',
            );
            return null;
        }

        const userId = await getTwitterUserId(username, authToken, ct0);

        const variables = {
            userId: userId,
            count: 10,
            includePromotedContent: false,
            withQuickPromoteEligibilityTweetFields: false,
            withVoice: false,
            withV2Timeline: true,
        };
        const features = {
            rweb_tipjar_consumption_enabled: true,
            responsive_web_graphql_exclude_directive_enabled: true,
            verified_phone_label_enabled: false,
            creator_subscriptions_tweet_preview_api_enabled: true,
            responsive_web_graphql_timeline_navigation_enabled: true,
            responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
            communities_web_enable_tweet_community_results_fetch: true,
            c9s_tweet_anatomy_moderator_badge_enabled: true,
            articles_preview_enabled: true,
            tweetypie_unmention_optimization_enabled: true,
            responsive_web_edit_tweet_api_enabled: true,
            graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
            view_counts_everywhere_api_enabled: true,
            longform_notetweets_consumption_enabled: true,
            responsive_web_twitter_article_tweet_consumption_enabled: true,
            tweet_awards_web_tipping_enabled: false,
            creator_subscriptions_quote_tweet_preview_enabled: false,
            freedom_of_speech_not_reach_fetch_enabled: true,
            standardized_nudges_misinfo: true,
            tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
            rweb_video_timestamps_enabled: true,
            longform_notetweets_rich_text_read_enabled: true,
            longform_notetweets_inline_media_enabled: true,
            responsive_web_enhance_cards_enabled: false,
        };

        const url = `https://x.com/i/api/graphql/V7H0Ap3_Hh2FyS75OCDO3Q/UserTweets?variables=${encodeURIComponent(JSON.stringify(variables))}&features=${encodeURIComponent(JSON.stringify(features))}`;
        const res = await fetch(url, {
            headers: {
                authorization: `Bearer ${TWITTER_BEARER_TOKEN}`,
                cookie: `auth_token=${authToken}; ct0=${ct0}`,
                'x-csrf-token': ct0,
                'x-twitter-active-user': 'yes',
                'x-twitter-auth-type': 'OAuth2Session',
                'user-agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            },
        });

        if (!res.ok) {
            throw new Error(
                `Failed to fetch user tweets for ${username}: HTTP ${res.status}`,
            );
        }

        const data = await res.json();
        const instructions =
            data?.data?.user?.result?.timeline_v2?.timeline?.instructions || [];

        for (const instr of instructions) {
            if (instr.type === 'TimelineAddEntries') {
                for (const entry of instr.entries) {
                    if (entry.content?.entryType === 'TimelineTimelineItem') {
                        const result =
                            entry.content.itemContent?.tweet_results?.result;
                        if (!result) continue;
                        const tweet = result.tweet || result;
                        const legacy = tweet.legacy;
                        if (!legacy) continue;

                        const isRetweet = !!legacy.retweeted_status_result;
                        const isReply = !!legacy.in_reply_to_status_id_str;

                        // リツイートやリプライは除外
                        if (isRetweet || isReply) continue;

                        const tweetId = legacy.id_str || tweet.rest_id;
                        return {
                            id: tweetId,
                            text: legacy.full_text,
                            url: `https://fxtwitter.com/${username}/status/${tweetId}`,
                        };
                    }
                }
            }
        }

        return null;
    }

    async function checkTwitter() {
        if (!config.TWITTER_UPDATES) return;

        const rawTargets = Array.isArray(config.TWITTER_UPDATES)
            ? config.TWITTER_UPDATES
            : [config.TWITTER_UPDATES];

        const targets = rawTargets.filter((t) => t && t.enabled !== false);

        for (const target of targets) {
            const username = target.username || target.nitterUsername;
            if (!username) continue;

            const roleId = target.roleId;

            try {
                const latestTweet = await fetchLatestTweet(username);

                if (!latestTweet) {
                    if (!initialCheckedUsers.has(username)) {
                        console.log(
                            `[${username}] 投稿がありません。新規投稿を監視します。`,
                        );
                        initialCheckedUsers.add(username);
                    }
                    continue;
                }

                const latestTweetGuid = latestTweet.id;
                const tweetLink = latestTweet.url;
                const lastKnownId = state.lastTweetGuids[username];

                if (latestTweetGuid && lastKnownId !== latestTweetGuid) {
                    if (initialCheckedUsers.has(username)) {
                        console.log(
                            `[${username}] 新規投稿を検出しました: ${tweetLink}`,
                        );
                        const roleMention = roleId ? `<@&${roleId}> ` : '';
                        const message = `${roleMention}**${username}**さんが新しいツイートを投稿しました！\n${tweetLink}`;
                        await sendNotification(message);
                    } else {
                        console.log(
                            `[${username}] 投稿ID ${latestTweetGuid} から監視を開始します。`,
                        );
                    }
                    state.lastTweetGuids[username] = latestTweetGuid;
                    state.lastTweetGuid = latestTweetGuid;
                    saveState();
                }
                initialCheckedUsers.add(username);
            } catch (error) {
                console.error(
                    `[${username}] X投稿の取得に失敗しました:`,
                    error.message,
                );
            }
        }
    }

    function scheduleNextTwitterCheck() {
        const minSeconds = config.CHECK_INTERVAL_MIN_SECONDS || 180;
        const maxSeconds = config.CHECK_INTERVAL_MAX_SECONDS || 300;
        const intervalSeconds =
            Math.floor(Math.random() * (maxSeconds - minSeconds + 1)) +
            minSeconds;

        console.log(`次のX投稿取得は${intervalSeconds}秒後です。`);

        timer = setTimeout(async () => {
            try {
                await checkTwitter();
            } catch (error) {
                console.error('X投稿の定期取得に失敗しました:', error.message);
            } finally {
                if (!stopped) scheduleNextTwitterCheck();
            }
        }, intervalSeconds * 1000);
    }

    checkTwitter().finally(() => {
        if (!stopped) scheduleNextTwitterCheck();
    });
    return () => {
        stopped = true;
        clearTimeout(timer);
    };
}
module.exports = { startGraphqlMonitor };
