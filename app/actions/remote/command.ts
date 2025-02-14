// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {IntlShape} from 'react-intl';
import {Alert} from 'react-native';

import {doAppSubmit, postEphemeralCallResponseForCommandArgs} from '@actions/remote/apps';
import {showPermalink} from '@actions/remote/permalink';
import {Client} from '@client/rest';
import {AppCommandParser} from '@components/autocomplete/slash_suggestion/app_command_parser/app_command_parser';
import {AppCallResponseTypes} from '@constants/apps';
import DeepLinkType from '@constants/deep_linking';
import DatabaseManager from '@database/manager';
import AppsManager from '@managers/apps_manager';
import IntegrationsManager from '@managers/integrations_manager';
import NetworkManager from '@managers/network_manager';
import {getChannelById} from '@queries/servers/channel';
import {getConfig, getCurrentTeamId} from '@queries/servers/system';
import {getTeammateNameDisplay, queryUsersByUsername} from '@queries/servers/user';
import {showAppForm, showModal} from '@screens/navigation';
import * as DraftUtils from '@utils/draft';
import {matchDeepLink, tryOpenURL} from '@utils/url';
import {displayUsername} from '@utils/user';

import {makeDirectChannel, switchToChannelById, switchToChannelByName} from './channel';

import type {DeepLinkChannel, DeepLinkPermalink, DeepLinkDM, DeepLinkGM, DeepLinkPlugin} from '@typings/launch';

export const executeCommand = async (serverUrl: string, intl: IntlShape, message: string, channelId: string, rootId?: string): Promise<{data?: CommandResponse; error?: string | {message: string}}> => {
    const operator = DatabaseManager.serverDatabases[serverUrl]?.operator;
    if (!operator) {
        return {error: `${serverUrl} database not found`};
    }

    let client: Client;
    try {
        client = NetworkManager.getClient(serverUrl);
    } catch (error) {
        return {error: error as ClientErrorProps};
    }

    const channel = await getChannelById(operator.database, channelId);
    const teamId = channel?.teamId || (await getCurrentTeamId(operator.database));

    const args: CommandArgs = {
        channel_id: channelId,
        team_id: teamId,
        root_id: rootId,
        parent_id: rootId,
    };

    const appsEnabled = await AppsManager.isAppsEnabled(serverUrl);
    if (appsEnabled) {
        const parser = new AppCommandParser(serverUrl, intl, channelId, teamId, rootId);
        if (parser.isAppCommand(message)) {
            return executeAppCommand(serverUrl, intl, parser, message, args);
        }
    }

    let msg = filterEmDashForCommand(message);

    let cmdLength = msg.indexOf(' ');
    if (cmdLength < 0) {
        cmdLength = msg.length;
    }

    const cmd = msg.substring(0, cmdLength).toLowerCase();
    if (cmd === '/code') {
        msg = cmd + ' ' + msg.substring(cmdLength, msg.length).trimEnd();
    } else {
        msg = cmd + ' ' + msg.substring(cmdLength, msg.length).trim();
    }

    let data;
    try {
        data = await client.executeCommand(msg, args);
    } catch (error) {
        return {error: error as ClientErrorProps};
    }

    if (data?.trigger_id) { //eslint-disable-line camelcase
        IntegrationsManager.getManager(serverUrl)?.setTriggerId(data.trigger_id);
    }

    return {data};
};

const executeAppCommand = async (serverUrl: string, intl: IntlShape, parser: AppCommandParser, msg: string, args: CommandArgs) => {
    const {creq, errorMessage} = await parser.composeCommandSubmitCall(msg);
    const createErrorMessage = (errMessage: string) => {
        return {error: {message: errMessage}};
    };

    if (!creq) {
        return createErrorMessage(errorMessage!);
    }

    const res = await doAppSubmit(serverUrl, creq, intl);
    if (res.error) {
        const errorResponse = res.error as AppCallResponse;
        return createErrorMessage(errorResponse.text || intl.formatMessage({
            id: 'apps.error.unknown',
            defaultMessage: 'Unknown error.',
        }));
    }
    const callResp = res.data as AppCallResponse;

    switch (callResp.type) {
        case AppCallResponseTypes.OK:
            if (callResp.text) {
                postEphemeralCallResponseForCommandArgs(serverUrl, callResp, callResp.text, args);
            }
            return {data: {}};
        case AppCallResponseTypes.FORM:
            if (callResp.form) {
                showAppForm(callResp.form, creq.context);
            }
            return {data: {}};
        case AppCallResponseTypes.NAVIGATE:
            if (callResp.navigate_to_url) {
                handleGotoLocation(serverUrl, intl, callResp.navigate_to_url);
            }
            return {data: {}};
        default:
            return createErrorMessage(intl.formatMessage({
                id: 'apps.error.responses.unknown_type',
                defaultMessage: 'App response type not supported. Response type: {type}.',
            }, {
                type: callResp.type,
            }));
    }
};

const filterEmDashForCommand = (command: string): string => {
    return command.replace(/\u2014/g, '--');
};

export const handleGotoLocation = async (serverUrl: string, intl: IntlShape, location: string) => {
    const operator = DatabaseManager.serverDatabases[serverUrl]?.operator;
    if (!operator) {
        return {error: `${serverUrl} database not found`};
    }
    const {database} = operator;

    const config = await getConfig(database);
    const match = matchDeepLink(location, serverUrl, config?.SiteURL);
    let linkServerUrl: string | undefined;
    if (match?.data?.serverUrl) {
        linkServerUrl = DatabaseManager.searchUrl(match.data.serverUrl);
    }

    if (match && linkServerUrl) {
        switch (match.type) {
            case DeepLinkType.Channel: {
                const data = match.data as DeepLinkChannel;
                switchToChannelByName(linkServerUrl, data.channelName, data.teamName, DraftUtils.errorBadChannel, intl);
                break;
            }
            case DeepLinkType.Permalink: {
                const data = match.data as DeepLinkPermalink;
                showPermalink(linkServerUrl, data.teamName, data.postId, intl);
                break;
            }
            case DeepLinkType.DirectMessage: {
                const data = match.data as DeepLinkDM;
                if (!data.userName) {
                    DraftUtils.errorUnkownUser(intl);
                    return {data: false};
                }

                if (data.serverUrl !== serverUrl) {
                    if (!database) {
                        return {error: `${serverUrl} database not found`};
                    }
                }
                const user = (await queryUsersByUsername(database, [data.userName]).fetch())[0];
                if (!user) {
                    DraftUtils.errorUnkownUser(intl);
                    return {data: false};
                }

                makeDirectChannel(linkServerUrl, user.id, displayUsername(user, intl.locale, await getTeammateNameDisplay(database)), true);
                break;
            }
            case DeepLinkType.GroupMessage: {
                const data = match.data as DeepLinkGM;
                if (!data.channelId) {
                    DraftUtils.errorBadChannel(intl);
                    return {data: false};
                }

                switchToChannelById(linkServerUrl, data.channelId);
                break;
            }
            case DeepLinkType.Plugin: {
                const data = match.data as DeepLinkPlugin;
                showModal('PluginInternal', data.id, {link: location});
                break;
            }
        }
    } else {
        const {formatMessage} = intl;
        const onError = () => Alert.alert(
            formatMessage({
                id: 'mobile.server_link.error.title',
                defaultMessage: 'Link Error',
            }),
            formatMessage({
                id: 'mobile.server_link.error.text',
                defaultMessage: 'The link could not be found on this server.',
            }),
        );

        tryOpenURL(location, onError);
    }
    return {data: true};
};

export const fetchCommands = async (serverUrl: string, teamId: string) => {
    let client: Client;
    try {
        client = NetworkManager.getClient(serverUrl);
    } catch (error) {
        return {error: error as ClientErrorProps};
    }
    try {
        return {commands: await client.getCommandsList(teamId)};
    } catch (error) {
        return {error: error as ClientErrorProps};
    }
};

export const fetchSuggestions = async (serverUrl: string, term: string, teamId: string, channelId: string, rootId?: string) => {
    let client: Client;
    try {
        client = NetworkManager.getClient(serverUrl);
    } catch (error) {
        return {error: error as ClientErrorProps};
    }

    try {
        return {suggestions: await client.getCommandAutocompleteSuggestionsList(term, teamId, channelId, rootId)};
    } catch (error) {
        return {error: error as ClientErrorProps};
    }
};
