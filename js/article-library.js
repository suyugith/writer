/* Article/version data model. Shared by the browser and the Node regression tests. */
(function (root) {
    class ArticleLibrary {
        constructor(data) {
            this.articles = data?.articles || [];
            this.activeId = data?.activeId || this.articles[0]?.id || null;
            if (!this.articles.some(article => article.id === this.activeId)) {
                this.activeId = this.articles[0]?.id || null;
            }
            for (const article of this.articles) {
                if (!Array.isArray(article.references)) article.references = [];
                if (!Array.isArray(article.submissions)) article.submissions = [];
            }
        }

        static titleFrom(text, fallback = '未命名文章') {
            const heading = text.match(/^#{1,6}\s+(.+)$/m);
            const title = (heading ? heading[1] : text.split('\n').find(line => line.trim()) || '')
                .replace(/[*_`]/g, '').trim();
            return title.slice(0, 60) || fallback;
        }

        static migrate(history, times, stars, interactions) {
            const library = new ArticleLibrary();
            const texts = Array.isArray(history) && history.length ? history : [''];
            const now = Date.now();
            const article = library.create('', '已有文章');
            article.history = texts.slice();
            article.times = texts.map((_, i) => times?.[i] || now - (texts.length - 1 - i) * 60000);
            article.stars = texts.map((_, i) => !!stars?.[i]);
            article.index = texts.length - 1;
            article.title = ArticleLibrary.titleFrom(texts[article.index], '已有文章');
            article.updatedAt = article.times[article.index];
            article.interactions = Array.isArray(interactions) ? interactions : [];
            return library;
        }

        get current() { return this.articles.find(article => article.id === this.activeId); }

        create(text = '', title = '') {
            text = text.replace(/\r\n?/g, '\n');
            const now = Date.now();
            const article = {
                id: `article_${now}_${Math.random().toString(36).slice(2, 10)}`,
                title: title || ArticleLibrary.titleFrom(text, `未命名文章 ${this.articles.length + 1}`),
                createdAt: now, updatedAt: now,
                history: [text], times: [now], stars: [false], index: 0, interactions: [],
                references: [], submissions: []
            };
            this.articles.push(article);
            this.activeId = article.id;
            return article;
        }

        switchTo(id) {
            if (!this.articles.some(article => article.id === id)) return false;
            this.activeId = id;
            return true;
        }

        deleteArticle(id) {
            const index = this.articles.findIndex(article => article.id === id);
            if (index < 0) return false;
            this.articles.splice(index, 1);
            if (!this.articles.length) this.create();
            else if (this.activeId === id) this.activeId = this.articles[Math.min(index, this.articles.length - 1)].id;
            return true;
        }

        save(text) {
            text = text.replace(/\r\n?/g, '\n');
            const article = this.current;
            if (!article || article.history[article.index]?.replace(/\r\n?/g, '\n') === text) return false;
            // Restoring/editing an earlier version keeps later versions and stars intact.
            article.history.push(text);
            article.times.push(Date.now());
            article.stars.push(false);
            article.index = article.history.length - 1;
            article.updatedAt = article.times[article.index];
            if (/^未命名文章(?: \d+)?$/.test(article.title)) {
                article.title = ArticleLibrary.titleFrom(text, article.title);
            }
            while (article.history.length > 99) {
                const evict = article.stars.findIndex((star, i) => !star && i !== article.index);
                if (evict === -1) break;
                article.history.splice(evict, 1);
                article.times.splice(evict, 1);
                article.stars.splice(evict, 1);
                if (article.index > evict) article.index--;
            }
            return true;
        }

        undo() {
            if (!this.current || this.current.index <= 0) return false;
            this.current.index--;
            return true;
        }

        toggleStar(index) {
            const article = this.current;
            if (!article || index < 0 || index >= article.history.length) return false;
            article.stars[index] = !article.stars[index];
            return true;
        }

        deleteVersion(index) {
            const article = this.current;
            if (!article || article.history.length <= 1 || index < 0 || index >= article.history.length) return false;
            article.history.splice(index, 1);
            article.times.splice(index, 1);
            article.stars.splice(index, 1);
            if (index < article.index) article.index--;
            else if (index === article.index) article.index = Math.max(0, index - 1);
            article.updatedAt = Date.now();
            return true;
        }

        toJSON() {
            return JSON.parse(JSON.stringify({ schemaVersion: 2, activeId: this.activeId, articles: this.articles }));
        }
    }
    root.ArticleLibrary = ArticleLibrary;
    if (typeof module !== 'undefined' && module.exports) module.exports = ArticleLibrary;
})(typeof globalThis !== 'undefined' ? globalThis : window);
