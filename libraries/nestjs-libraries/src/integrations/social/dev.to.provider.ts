import {
  AuthTokenDetails,
  PostDetails,
  PostResponse,
  SocialProvider,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { SocialAbstract } from '@gitroom/nestjs-libraries/integrations/social.abstract';
import dayjs from 'dayjs';
import { Integration } from '@prisma/client';
import { makeSecureId } from '@gitroom/nestjs-libraries/services/make.secure.id';
import { DevToSettingsDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/dev.to.settings.dto';
import { Tool } from '@gitroom/nestjs-libraries/integrations/tool.decorator';

export class DevToProvider extends SocialAbstract implements SocialProvider {
  override maxConcurrentJob = 3; // Dev.to has moderate publishing limits
  identifier = 'devto';
  name = 'Dev.to';
  isBetweenSteps = false;
  editor = 'markdown' as const;
  scopes = [] as string[];
  maxLength() {
    return 100000;
  }
  dto = DevToSettingsDto;

  async generateAuthUrl() {
    const state = makeSecureId(6);
    return {
      url: state,
      codeVerifier: makeSecureId(10),
      state,
    };
  }

  override handleErrors(body: string) {
    if (body.indexOf('Canonical url has already been taken') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Canonical URL already exists',
      };
    }

    return undefined;
  }

  async refreshToken(refreshToken: string): Promise<AuthTokenDetails> {
    return {
      refreshToken: '',
      expiresIn: 0,
      accessToken: '',
      id: '',
      name: '',
      picture: '',
      username: '',
    };
  }

  async customFields() {
    return [
      {
        key: 'apiKey',
        label: 'API key',
        validation: `/^.{3,}$/`,
        type: 'password' as const,
      },
    ];
  }

  async authenticate(params: {
    code: string;
    codeVerifier: string;
    refresh?: string;
  }) {
    const body = JSON.parse(Buffer.from(params.code, 'base64').toString());
    try {
      const { name, id, profile_image, username } = await (
        await fetch('https://dev.to/api/users/me', {
          headers: {
            'api-key': body.apiKey,
          },
        })
      ).json();

      return {
        refreshToken: '',
        expiresIn: dayjs().add(100, 'years').unix() - dayjs().unix(),
        accessToken: body.apiKey,
        id,
        name,
        picture: profile_image || '',
        username,
      };
    } catch (err) {
      return 'Invalid credentials';
    }
  }

  @Tool({ description: 'Tag list', dataSchema: [] })
  async tags(token: string) {
    const tags = await (
      await fetch('https://dev.to/api/tags?per_page=1000&page=1', {
        headers: {
          'api-key': token,
        },
      })
    ).json();

    return tags.map((p: any) => ({ value: p.id, label: p.name }));
  }

  @Tool({ description: 'Organization list', dataSchema: [] })
  async organizations(token: string) {
    // The Forem API has no "organizations of the current user" endpoint, and
    // upstream only looked at past articles, so a fresh organization could
    // never be picked. Collect candidates from (1) past articles, (2) the
    // "Organizations" card of the user's public profile page and (3) the
    // optional DEVTO_ORGANIZATIONS env (comma separated usernames), then keep
    // only organizations whose member list contains the current user.
    const headers = { 'api-key': token };
    const safeJson = async (url: string) => {
      try {
        const res = await fetch(url, { headers });
        return res.ok ? await res.json() : null;
      } catch (err) {
        return null;
      }
    };

    const me = await safeJson('https://dev.to/api/users/me');
    const candidates = new Set<string>();

    const articles = await safeJson(
      'https://dev.to/api/articles/me/all?per_page=1000'
    );
    if (Array.isArray(articles)) {
      for (const article of articles) {
        if (article?.organization?.username) {
          candidates.add(article.organization.username);
        }
      }
    }

    if (me?.username) {
      try {
        const html = await (
          await fetch(`https://dev.to/${encodeURIComponent(me.username)}`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Postiz)' },
          })
        ).text();
        const card = html.split('spec-org-titles')[1]?.split('</div>')[0] || '';
        for (const match of card.matchAll(/href="\/([A-Za-z0-9_-]+)"/g)) {
          candidates.add(match[1]);
        }
      } catch (err) {
        /* profile page is a best-effort source */
      }
    }

    for (const org of (process.env.DEVTO_ORGANIZATIONS || '').split(',')) {
      if (org.trim()) {
        candidates.add(org.trim());
      }
    }

    const fullDetails = await Promise.all(
      [...candidates].map(async (org: string) => {
        const details = await safeJson(
          `https://dev.to/api/organizations/${encodeURIComponent(org)}`
        );
        if (!details?.id) {
          return null;
        }
        if (me?.id) {
          const members = await safeJson(
            `https://dev.to/api/organizations/${encodeURIComponent(
              org
            )}/users?per_page=1000`
          );
          if (
            Array.isArray(members) &&
            !members.some((m: any) => m?.id === me.id)
          ) {
            return null;
          }
        }
        return details;
      })
    );

    return fullDetails
      .filter((org: any) => org)
      .map((org: any) => ({
        id: org.id,
        name: org.name,
        username: org.username,
      }));
  }

  async post(
    id: string,
    accessToken: string,
    postDetails: PostDetails[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const { settings } = postDetails?.[0] || { settings: {} };
    const { id: postId, url } = await (
      await this.fetch(`https://dev.to/api/articles`, {
        method: 'POST',
        body: JSON.stringify({
          article: {
            title: settings.title,
            body_markdown: postDetails?.[0].message,
            published: true,
            ...(settings?.main_image?.path
              ? { main_image: settings?.main_image?.path }
              : {}),
            tags: settings?.tags?.map((t: any) => t.label),
            organization_id: settings.organization,
            ...(settings.canonical
              ? { canonical_url: settings.canonical }
              : {}),
          },
        }),
        headers: {
          'Content-Type': 'application/json',
          'api-key': accessToken,
        },
      })
    ).json();

    return [
      {
        id: postDetails?.[0].id,
        status: 'completed',
        postId: String(postId),
        releaseURL: url,
      },
    ];
  }
}
