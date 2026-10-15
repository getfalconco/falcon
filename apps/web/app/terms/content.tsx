import { A, Conspicuous, Fact, H3, LI, Mail, P, Term, UL, type LegalSectionDef } from "../components/legal/primitives";

/**
 * The Terms of Service. Section ids are anchors other surfaces link to (the
 * desktop app's "Usage policy" row opens #acceptable-use); never rename one.
 *
 * Facts about the operator (name, address, governing law, contacts) come from
 * lib/legal-config and show as highlighted placeholders until filled in.
 */

export const TERMS_INTRO = (
  <>
    <P>
      These Terms of Service (the &quot;Terms&quot;) are an agreement between you and <Fact k="entityName" />{" "}
      (&quot;Falcon&quot;, &quot;we&quot;, &quot;us&quot; or &quot;our&quot;). They govern your use of the Falcon desktop
      application, the website at getfalcon.co, our waitlist and early-access programme, and the related services we
      run to power them (together, the &quot;Service&quot;).
    </P>
    <P>
      Please read Sections 5 to 9 with care. Falcon is a research tool. It does not give investment advice, it is not a
      broker-dealer or an investment adviser, and much of what it shows is produced automatically, including by AI
      models, and can be wrong. Sections 18 to 21 limit our liability and explain how disputes are resolved.
    </P>
  </>
);

export const TERMS_SECTIONS: readonly LegalSectionDef[] = [
  {
    id: "agreement",
    title: "Agreement to these Terms",
    body: (
      <>
        <P>
          By creating an account, joining the waitlist, applying for early access, downloading or using the desktop
          application, or otherwise using the Service, you agree to these Terms and to our{" "}
          <A href="/privacy">Privacy Policy</A>, which explains how we handle personal data. If you do not agree, do
          not use the Service.
        </P>
        <P>
          If you use the Service on behalf of a company or other organisation, you confirm that you are authorised to
          accept these Terms for it, and &quot;you&quot; includes that organisation.
        </P>
      </>
    ),
  },
  {
    id: "eligibility",
    title: "Eligibility",
    body: (
      <>
        <P>
          You must be at least 18 years old, and of legal age to form a binding contract where you live, to use the
          Service. The Service deals with financial markets and is not directed at children.
        </P>
        <P>
          You may not use the Service if you are barred from doing so under the laws that apply to you, or if you are
          located in, or ordinarily resident in, a country or region subject to comprehensive sanctions, or are named
          on a government sanctions or restricted-party list.
        </P>
      </>
    ),
  },
  {
    id: "accounts",
    title: "Accounts and early access",
    body: (
      <>
        <P>
          Falcon is currently offered through a waitlist and early-access programme. We decide, at our discretion,
          who is admitted and when, and we may limit the number of accounts.
        </P>
        <P>
          You agree to give accurate information when you apply or register and to keep it up to date. Your account
          is for you alone: do not share your sign-in details or let anyone else use your account. You are responsible
          for keeping your password and devices secure and for all activity under your account. Tell us promptly at{" "}
          <Mail k="contactEmail" /> if you believe your account has been compromised.
        </P>
      </>
    ),
  },
  {
    id: "the-service",
    title: "What Falcon is",
    body: (
      <>
        <P>
          Falcon is a research and information tool for people who do their own work on publicly traded companies.
          Among other things, it reads public SEC filings to map relationships between companies, follows market
          news, traces how a news event may relate to other companies through those relationships, produces written
          summaries and briefings, lets you set up automated research agents, and offers a simulated (paper)
          portfolio and an optional read-only view of a linked brokerage account.
        </P>
        <P>
          Features change often during early access. We may add, change or remove any part of the Service, and some
          features may only be available on certain plans, platforms or regions.
        </P>
      </>
    ),
  },
  {
    id: "not-investment-advice",
    title: "Not investment advice",
    body: (
      <>
        <P>
          <Term>Falcon provides general information and research tools only.</Term> Nothing in the Service is, or
          should be read as, investment, financial, legal, tax or accounting advice, a recommendation, an offer, or a
          solicitation to buy, sell or hold any security, derivative or other financial instrument, or to follow any
          strategy.
        </P>
        <UL>
          <LI>
            <Term>No personalised advice.</Term> Content in the Service is impersonal. It is not tailored to your
            objectives, financial situation, risk tolerance or needs, even where it refers to positions you hold or
            tickers you follow. Labels, scores, rankings, &quot;signals&quot;, directions, priorities or tiers are
            descriptive outputs of automated methods, not recommendations.
          </LI>
          <LI>
            <Term>Not a broker-dealer or investment adviser.</Term> Falcon is not registered as a broker-dealer,
            investment adviser, financial adviser or similar regulated firm with the U.S. Securities and Exchange
            Commission, FINRA, any state securities regulator, or any other financial regulator. Falcon does not
            execute trades, hold your money or securities, or manage accounts.
          </LI>
          <LI>
            <Term>No fiduciary or advisory relationship.</Term> Using the Service does not create a fiduciary,
            advisory, brokerage or other professional relationship between you and Falcon, its personnel or its data
            providers.
          </LI>
          <LI>
            <Term>Your decisions are yours.</Term> You are solely responsible for your investment decisions and for
            evaluating the merits and risks of any information you use. Before making financial decisions you should
            do your own research and, where appropriate, consult a licensed professional.
          </LI>
          <LI>
            <Term>Past results.</Term> Any track record, back-test, historical comparison or performance figure shown
            in the Service describes the past, may be calculated on simplifying assumptions, and does not indicate or
            guarantee future results. Investing involves risk, including loss of principal.
          </LI>
        </UL>
        <P>
          People who build, run or invest in Falcon may hold or trade securities that the Service covers. The Service
          does not take their positions into account and is not a channel for their views.
        </P>
      </>
    ),
  },
  {
    id: "data-accuracy",
    title: "Data accuracy and timeliness",
    body: (
      <>
        <P>
          Prices, quotes, news, filings, relationship graphs, calendars, earnings data and other information in the
          Service come from third parties and automated processing. They may be delayed, incomplete, out of date,
          incorrectly attributed or wrong, and sources can be unavailable without notice. Quotes may not be real-time.
          Relationships extracted from filings reflect what a filing said when it was filed, as read by automated
          tools, and may not reflect current facts.
        </P>
        <P>
          We do not guarantee the accuracy, completeness, timeliness, sequence or availability of any information in
          the Service. Do not rely on it as your only source for any decision, and do not use the Service where a
          delay, error or omission could cause loss that you are not prepared to bear.
        </P>
      </>
    ),
  },
  {
    id: "third-party-data",
    title: "Third-party data and services",
    body: (
      <>
        <P>
          The Service shows or relies on information and services from third parties, including market data and news
          providers (such as Finnhub, Yahoo Finance and Nasdaq), the U.S. Securities and Exchange Commission&apos;s
          EDGAR system, AI model providers, and the brokerage-connection provider described in Section 10. Third-party
          content belongs to its owners and is provided to you for your personal, non-commercial use within the
          Service only.
        </P>
        <P>
          You may not copy, redistribute, resell, publish or create derivative databases from third-party data
          obtained through the Service. Third-party providers may impose their own terms, which may change, and may
          limit or end what they supply to us; when they do, the related features may change or stop. We are not
          responsible for third-party content, sites or services, and a link to them is not an endorsement.
        </P>
      </>
    ),
  },
  {
    id: "ai-content",
    title: "AI-generated and automated content",
    body: (
      <>
        <P>
          Many parts of the Service are produced automatically, including by large language models provided by
          Anthropic (Claude). This includes, for example, relationship extraction from filings, the short read Falcon
          gives on a news story, signal explanations, briefings, Insight chat answers, and the reports written by
          research agents you set up.
        </P>
        <UL>
          <LI>
            Automated and AI-generated content can be inaccurate, incomplete, out of date, inconsistent or
            misleading, and can state incorrect things confidently. It is generally not reviewed by a person before
            you see it.
          </LI>
          <LI>
            Citations, quotations and sources shown with a claim may be wrong or may not support the claim. Check the
            underlying source before relying on anything.
          </LI>
          <LI>
            Similar inputs can produce different outputs, and other users may receive similar or identical outputs.
          </LI>
          <LI>
            You are responsible for how you use automated content, including verifying it independently, and you must
            not present it to others as personalised advice or as professional analysis by Falcon.
          </LI>
        </UL>
      </>
    ),
  },
  {
    id: "paper-trading",
    title: "Paper trading is simulated",
    body: (
      <>
        <P>
          The paper portfolio is a simulation. No real orders are placed, no money or securities move, and no
          brokerage account is affected. Simulated fills, prices, values, profit and loss, and risk readings are
          estimates based on data that may be delayed or inaccurate, and they ignore many factors that affect real
          trading (such as liquidity, fees, taxes, slippage and market impact). Simulated results do not indicate
          what you would achieve with real money.
        </P>
      </>
    ),
  },
  {
    id: "brokerage-connections",
    title: "Brokerage connections",
    body: (
      <>
        <P>
          You can choose to link a brokerage account through SnapTrade, a third-party connection provider. The link
          is set up in your browser on SnapTrade&apos;s and your brokerage&apos;s own pages; Falcon never sees or
          stores your brokerage username or password. Falcon requests a <Term>read-only</Term> connection, used to
          show your linked accounts and their balances in the app. Falcon does not place, change or cancel orders, or
          move money or securities, through a linked account.
        </P>
        <P>
          Your use of SnapTrade is subject to SnapTrade&apos;s own terms and privacy policy, and your relationship
          with your brokerage is governed by your agreement with it. Holdings data may be delayed or incomplete, and a
          connection may stop working if SnapTrade or your brokerage changes or ends access. You can remove a
          connection at any time in the app or with your brokerage. The way brokerage data is handled is described in
          our <A href="/privacy#categories">Privacy Policy</A>.
        </P>
      </>
    ),
  },
  {
    id: "your-content",
    title: "Your content",
    body: (
      <>
        <P>
          &quot;Your Content&quot; means what you put into the Service: for example your profile details and
          instructions, watchlists, paper portfolio entries, research requests, agent configurations, calendar
          events, questions you ask in Insight chat, and messages to agents. You keep any rights you have in Your
          Content.
        </P>
        <P>
          You grant us a worldwide, non-exclusive, royalty-free licence to host, store, copy, process, transmit and
          display Your Content only as needed to provide, secure and improve the Service for you, including sending
          it to the service providers listed in our Privacy Policy for those purposes. This licence ends when Your
          Content is deleted from the Service, except for copies we must keep by law or that remain for a limited
          time in backups.
        </P>
        <P>
          You are responsible for Your Content and confirm you have the rights needed to provide it. Do not put
          material non-public information, information you are under a duty to keep confidential, or other
          people&apos;s personal data into the Service.
        </P>
        <P>
          Outputs generated for you (such as briefings and agent reports) are provided for your own use under these
          Terms. To the extent we have rights in them, you may use them for your own personal research, subject to
          Section 12 and to the rights of third-party data providers in any data they contain.
        </P>
      </>
    ),
  },
  {
    id: "acceptable-use",
    title: "Acceptable use",
    body: (
      <>
        <P>
          This section is Falcon&apos;s usage policy. It applies to everything you do with the Service, including the
          desktop application, its automated agents, and its AI features. You agree not to, and not to help anyone
          else to:
        </P>
        <H3>Markets and the law</H3>
        <UL>
          <LI>
            use the Service to engage in or facilitate market manipulation, insider trading, front-running, spoofing,
            pump-and-dump schemes, or any other conduct that breaches securities, commodities or financial laws;
          </LI>
          <LI>
            put material non-public information into the Service, or use the Service to spread information you know
            or suspect to be false or misleading about a security or issuer;
          </LI>
          <LI>
            use the Service to provide investment advice, research or signals to others in a way that requires a
            licence or registration you do not hold, or present Falcon output as your own professional advice;
          </LI>
          <LI>use the Service in breach of sanctions, export controls or any other applicable law.</LI>
        </UL>
        <H3>Data and output</H3>
        <UL>
          <LI>
            scrape, crawl, bulk-download or systematically extract data or output from the Service, by automated
            means or otherwise, beyond normal personal use of its features;
          </LI>
          <LI>
            resell, sublicense, redistribute, publish or commercially exploit the Service, its output, or third-party
            data obtained through it, without our written permission;
          </LI>
          <LI>
            use the Service or its output to build or train a competing product, dataset or machine-learning model.
          </LI>
        </UL>
        <H3>Security and integrity</H3>
        <UL>
          <LI>
            copy, modify, decompile, disassemble or reverse engineer the application or our services, except to the
            extent the law expressly allows despite this restriction;
          </LI>
          <LI>
            bypass or attempt to bypass authentication, access controls, usage limits, rate limits or plan
            restrictions, or attempt to extract service keys or credentials from the application or our servers;
          </LI>
          <LI>
            call our engine, research worker or other back-end services other than through the official application,
            or send them traffic designed to overload or disrupt them;
          </LI>
          <LI>
            probe, scan or test the vulnerability of the Service without our written permission (if you believe you
            have found a security issue, please report it to <Mail k="contactEmail" />);
          </LI>
          <LI>upload or transmit malware or any other harmful code;</LI>
          <LI>
            attempt to manipulate the AI features into ignoring their instructions, revealing their configuration, or
            producing content that breaks these Terms.
          </LI>
        </UL>
        <H3>Accounts and other people</H3>
        <UL>
          <LI>share, sell or transfer your account, or create accounts by automated means or under false details;</LI>
          <LI>
            impersonate any person, or misrepresent your affiliation with any person or with Falcon;
          </LI>
          <LI>
            use the Service to harass anyone, or to infringe anyone&apos;s intellectual property, privacy or other
            rights.
          </LI>
        </UL>
        <P>
          We may investigate suspected breaches of this section, and may remove content, limit features, or suspend
          or end access as described in Section 17. Where we are required to, we may report conduct to the relevant
          authorities.
        </P>
      </>
    ),
  },
  {
    id: "intellectual-property",
    title: "Intellectual property and feedback",
    body: (
      <>
        <P>
          The Service, including its software, design, text, graphics, relationship graphs, compilations and the
          Falcon name and marks, is owned by us or our licensors and is protected by intellectual property laws.
          Except for the limited rights expressly granted in these Terms, no rights are transferred to you.
        </P>
        <P>
          If you send us ideas, suggestions or other feedback, you allow us to use them for any purpose without
          restriction or payment to you. We are under no obligation to use feedback.
        </P>
      </>
    ),
  },
  {
    id: "software-licence",
    title: "Desktop application licence and updates",
    body: (
      <>
        <P>
          Subject to these Terms, we grant you a personal, limited, non-exclusive, non-transferable, revocable licence
          to install and use the Falcon desktop application on devices you own or control, solely to access the
          Service for your own use.
        </P>
        <P>
          The application checks for updates and may download and install them. Some updates may be required to keep
          using the Service. The application includes open-source components that are licensed under their own
          terms, which govern those components.
        </P>
      </>
    ),
  },
  {
    id: "early-access",
    title: "Early access and beta features",
    body: (
      <>
        <P>
          The Service is in early access. Features may be experimental, incomplete, or labelled as preview,
          developer or beta. They may contain errors, may change or be withdrawn at any time, and may lose or reset
          data. We may stop offering the early-access programme. Beta features are provided as they are, without any
          commitment of availability or support.
        </P>
      </>
    ),
  },
  {
    id: "fees",
    title: "Fees and plans",
    body: (
      <>
        <P>
          Plans, tiers and any prices we describe are set out on getfalcon.co and may change. At present, no payments
          are taken inside the desktop application.
        </P>
        <P>
          If we offer paid plans, the price, billing period, renewal, cancellation and refund terms, and any taxes
          will be shown to you before you buy, and you will be asked to agree to them at that point. Those terms will
          apply in addition to these Terms. Nothing in these Terms obliges you to pay for anything you have not
          expressly agreed to buy. Any statutory rights you have as a consumer, such as a right to withdraw from a
          purchase, are not affected.
        </P>
      </>
    ),
  },
  {
    id: "termination",
    title: "Suspension and termination",
    body: (
      <>
        <P>
          You can stop using the Service at any time, and you can delete your account from the desktop application
          (Settings, Account). Deleting your account removes the data described in our{" "}
          <A href="/privacy#retention">Privacy Policy</A>.
        </P>
        <P>
          We may suspend or end your access, with or without notice, if you breach these Terms, if your use creates
          risk or possible legal exposure for us or others, if required by law or by a provider we depend on, or if we
          stop offering the Service or the early-access programme. Where reasonable, we will tell you in advance and
          give you a chance to export your data.
        </P>
        <P>
          Sections that by their nature should survive termination will survive, including Sections 5 to 8, 11
          (licence to the extent needed for retained copies), 13, and 18 to 23.
        </P>
      </>
    ),
  },
  {
    id: "disclaimers",
    title: "Disclaimers",
    body: (
      <>
        <Conspicuous>
          To the fullest extent permitted by law, the Service and all content, data and output in it are provided
          &quot;as is&quot; and &quot;as available&quot;, without warranties of any kind, whether express, implied or
          statutory, including any implied warranties of merchantability, fitness for a particular purpose, title,
          non-infringement, accuracy, and quiet enjoyment, and any warranties arising from course of dealing or usage
          of trade.
        </Conspicuous>
        <P>
          Without limiting the above, we do not warrant that the Service will be uninterrupted, secure or error-free,
          that defects will be corrected, that any data or output is accurate, complete or current, or that the
          Service will meet your requirements or produce any particular result, including any investment result.
        </P>
        <P>
          Some jurisdictions do not allow the exclusion of certain warranties, so some of the above may not apply to
          you. If you are a consumer, you have statutory rights that these Terms do not affect.
        </P>
      </>
    ),
  },
  {
    id: "limitation-of-liability",
    title: "Limitation of liability",
    body: (
      <>
        <Conspicuous>
          To the fullest extent permitted by law, Falcon and its affiliates, officers, employees, agents, licensors and
          data providers will not be liable for any indirect, incidental, special, consequential, exemplary or punitive
          damages, or for any loss of profits, revenue, trading or investment losses, loss of data, or loss of
          goodwill, arising out of or relating to the Service or these Terms, however caused and on any theory of
          liability, even if advised of the possibility of such damages.
        </Conspicuous>
        <Conspicuous>
          To the fullest extent permitted by law, our total liability for all claims arising out of or relating to the
          Service or these Terms will not exceed the greater of (a) the amounts you paid us for the Service in the
          twelve months before the event giving rise to the claim and (b) one hundred U.S. dollars (US$100).
        </Conspicuous>
        <P>
          Nothing in these Terms limits or excludes liability that cannot be limited or excluded under applicable law,
          including liability for death or personal injury caused by negligence, for fraud or fraudulent
          misrepresentation, or, where you are a consumer in the European Union or the United Kingdom, liability for
          gross negligence or wilful misconduct or for breach of your mandatory statutory rights.
        </P>
      </>
    ),
  },
  {
    id: "indemnity",
    title: "Indemnity",
    body: (
      <>
        <P>
          To the extent permitted by law, you will defend, indemnify and hold harmless Falcon and its affiliates,
          officers, employees and agents from any third-party claims, and related losses, damages, liabilities, costs
          and reasonable legal fees, arising out of your breach of these Terms, your misuse of the Service, Your
          Content, or your violation of any law or third-party right. This section does not apply to you to the extent
          you are a consumer and the law where you live does not permit it.
        </P>
      </>
    ),
  },
  {
    id: "governing-law",
    title: "Governing law and disputes",
    body: (
      <>
        <P>
          These Terms and any dispute or claim arising out of or relating to them or the Service, including
          non-contractual disputes, are governed by <Fact k="governingLaw" />, without regard to its conflict-of-law
          rules.
        </P>
        <P>
          Before starting formal proceedings, please contact us at <Mail k="contactEmail" /> and give us a chance to
          resolve the issue informally. Both sides will try in good faith to resolve it within 30 days.
        </P>
        <P>
          If it is not resolved, the dispute will be heard exclusively by <Fact k="venue" />, and you and we submit to
          their jurisdiction. If you are a consumer living in the European Union, the United Kingdom, Turkey or another
          country whose law gives you the right to bring proceedings in your local courts, or to rely on mandatory
          consumer protections of the place where you live, nothing in this section takes those rights away. EU
          consumers may also use the European Commission&apos;s online dispute resolution information at{" "}
          <A href="https://consumer-redress.ec.europa.eu">consumer-redress.ec.europa.eu</A>.
        </P>
      </>
    ),
  },
  {
    id: "changes",
    title: "Changes to these Terms",
    body: (
      <>
        <P>
          We may update these Terms from time to time, for example to reflect new features, paid plans or changes in
          law. We will post the updated Terms on this page and change the &quot;Last updated&quot; date. If a change
          materially affects your rights, we will give you reasonable notice before it takes effect, for example by
          email or in the application. If you continue to use the Service after a change takes effect, the updated
          Terms apply; if you do not agree, you should stop using the Service and may delete your account.
        </P>
      </>
    ),
  },
  {
    id: "general",
    title: "General",
    body: (
      <>
        <UL>
          <LI>
            <Term>Entire agreement.</Term> These Terms, together with the Privacy Policy and any terms you accept for a
            specific feature or purchase, are the entire agreement between you and us about the Service.
          </LI>
          <LI>
            <Term>Severability.</Term> If any provision is found unenforceable, it will be enforced to the maximum
            extent permitted and the rest of these Terms will remain in effect.
          </LI>
          <LI>
            <Term>No waiver.</Term> Not enforcing a provision is not a waiver of our right to do so later.
          </LI>
          <LI>
            <Term>Assignment.</Term> You may not transfer your rights or obligations under these Terms without our
            consent. We may transfer ours in connection with a merger, acquisition, reorganisation or sale of assets,
            or to an affiliate, provided your rights are not reduced as a result.
          </LI>
          <LI>
            <Term>Events beyond our control.</Term> We are not responsible for delays or failures caused by events
            beyond our reasonable control, including failures of third-party data providers, hosting or networks.
          </LI>
          <LI>
            <Term>Notices.</Term> We may give you notices by email to the address on your account or in the
            application. You may give us notices at <Mail k="contactEmail" />.
          </LI>
          <LI>
            <Term>Language.</Term> These Terms are written in English. If we provide a translation, the English
            version controls to the extent permitted by law.
          </LI>
        </UL>
      </>
    ),
  },
  {
    id: "contact",
    title: "Contact",
    body: (
      <>
        <P>
          The Service is operated by <Fact k="entityName" />, registered in <Fact k="country" /> under number{" "}
          <Fact k="registrationNumber" />, with its registered office at <Fact k="address" />.
        </P>
        <P>
          Questions about these Terms: <Mail k="contactEmail" />.
        </P>
      </>
    ),
  },
];
