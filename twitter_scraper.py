import json
import sys
from ntscraper import Nitter

def get_latest_tweet(username):
    scraper = Nitter()
    try:
        tweets = scraper.get_tweets(username, mode='user', number=10)
        
        for tweet in tweets['tweets']:
            is_reply = tweet['text'].startswith('@')
            is_retweet = tweet['is-retweet']
            
            if not is_reply and not is_retweet:
                tweet_id = tweet['link'].split('/')[-1].split('#')[0]
                tweet_link = f"https://vxtwitter.com{tweet['link']}"
                
                print(json.dumps({
                    "id": tweet_id,
                    "link": tweet_link
                }))
                return
    
    except Exception as e:
        pass

if __name__ == "__main__":
    if len(sys.argv) > 1:
        get_latest_tweet(sys.argv[1])
